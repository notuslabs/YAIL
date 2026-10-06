import { createHash } from "node:crypto";
import type { Db } from "../db/client.js";
import { sql } from "../db/sql.js";
import { sourceCache } from "../db/internal.js";
import { normalizeHex } from "../util.js";
import type { BatchOf, BitcoinSource, EvmSource, FetchOptions, QueryOf, RangeQuery, Source } from "./types.js";

export interface CachedSourceOptions {
  db: Db;
  /** Chain name used as cache namespace. */
  chain: string;
  /** Only cache batches whose range ends at or below this height (avoid caching reorgable data). */
  finalizedHeight?: () => number | undefined;
  onEvent?: (event: { type: "hit" | "miss" | "store"; fromBlock: number; nextBlock: number }) => void;
}

/**
 * Wrap any source with a ClickHouse-backed page cache. The wrapped source has
 * the same interface; ranges already cached are served from the database and
 * gaps are fetched from the inner source and stored. Cache keys hash the query
 * shape (filters) so different filter sets never mix.
 */
export function cached<S extends Source>(inner: S, options: CachedSourceOptions): S {
  const fetch = inner.fetch.bind(inner) as (query: QueryOf<S>, options?: FetchOptions) => AsyncIterable<BatchOf<S>>;
  const wrapped = {
    kind: inner.kind,
    name: `cached(${inner.name})`,
    getHeight: () => inner.getHeight(),
    async *fetch(query: QueryOf<S>, fetchOptions?: FetchOptions): AsyncIterable<BatchOf<S>> {
      const queryHash = hashQuery(query);
      const cachedRanges = await options.db.query<{ from_block: string; next_block: string }>(
        sql`SELECT from_block, next_block FROM ${sourceCache} FINAL
            WHERE chain = ${options.chain} AND query_hash = ${queryHash}
              AND from_block >= ${query.fromBlock} AND from_block < ${query.toBlock}
            ORDER BY from_block`,
      );
      const ranges = cachedRanges.map((r) => ({ from: Number(r.from_block), next: Number(r.next_block) }));
      let cursor = query.fromBlock;
      let ri = 0;
      while (cursor < query.toBlock) {
        fetchOptions?.signal?.throwIfAborted();
        while (ri < ranges.length && ranges[ri]!.next <= cursor) ri++;
        const hit = ranges[ri];
        if (hit && hit.from === cursor) {
          const rows = await options.db.query<{ payload: string }>(
            sql`SELECT payload FROM ${sourceCache} FINAL WHERE chain = ${options.chain} AND query_hash = ${queryHash} AND from_block = ${cursor} LIMIT 1`,
          );
          const payload = rows[0]?.payload;
          if (payload) {
            const batch = reviveBatch(payload) as BatchOf<S>;
            const next = Math.min(batch.nextBlock, query.toBlock);
            options.onEvent?.({ type: "hit", fromBlock: cursor, nextBlock: next });
            yield clampBatch(batch, next);
            cursor = next;
            continue;
          }
        }
        // Miss: fetch from inner up to the next cached range start (or the end).
        let missEnd = query.toBlock;
        if (hit) missEnd = Math.min(hit.from, missEnd);
        options.onEvent?.({ type: "miss", fromBlock: cursor, nextBlock: missEnd });
        const finalized = options.finalizedHeight?.();
        for await (const batch of fetch({ ...query, fromBlock: cursor, toBlock: missEnd }, fetchOptions)) {
          if (finalized === undefined || batch.nextBlock - 1 <= finalized) {
            await options.db.insert(sourceCache).values({
              chain: options.chain,
              queryHash,
              fromBlock: BigInt(batch.fromBlock),
              nextBlock: BigInt(batch.nextBlock),
              payload: serializeBatch(batch),
              createdAt: new Date(),
            });
            options.onEvent?.({ type: "store", fromBlock: batch.fromBlock, nextBlock: batch.nextBlock });
          }
          yield batch;
          cursor = batch.nextBlock;
        }
        if (cursor < missEnd) throw new Error(`cached(${inner.name}): inner source stopped at ${cursor} before ${missEnd}`);
      }
    },
  };
  return {
    ...wrapped,
    ...(inner.kind === "evm" && inner.getBlock ? { getBlock: (n: number) => inner.getBlock!(n) } : {}),
    ...(inner.firstBlock ? { firstBlock: () => inner.firstBlock!() } : {}),
  } as S;
}

/** Hash of the query minus its block range. */
export function hashQuery(query: RangeQuery): string {
  const { fromBlock: _f, toBlock: _t, ...shape } = query;
  const json = JSON.stringify(shape, (_k, v) => {
    if (typeof v === "string") return normalizeHex(v);
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return [...v].map(normalizeHex).sort();
    return v;
  });
  return createHash("sha256").update(json).digest("hex").slice(0, 32);
}

export function serializeBatch(batch: unknown): string {
  return JSON.stringify(batch, tagBigint);
}

export function reviveBatch(payload: string): unknown {
  return JSON.parse(payload, untagBigint);
}

function tagBigint(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return { $big: value.toString() };
  return value;
}

function untagBigint(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && "$big" in value && typeof value.$big === "string") return BigInt(value.$big);
  return value;
}

function clampBatch<B extends BatchOf<Source>>(batch: B, next: number): B {
  if (batch.nextBlock === next) return batch;
  if ("logs" in batch) {
    return {
      ...batch,
      nextBlock: next,
      blocks: batch.blocks.filter((b) => b.number < next),
      transactions: batch.transactions.filter((t) => t.blockNumber < next),
      logs: batch.logs.filter((l) => l.blockNumber < next),
      ...(batch.traces ? { traces: batch.traces.filter((t) => t.blockNumber < next) } : {}),
    };
  }
  if ("balances" in batch) {
    return {
      ...batch,
      nextBlock: next,
      blocks: batch.blocks.filter((b) => b.slot < next),
      transactions: batch.transactions.filter((t) => t.slot < next),
      balances: batch.balances.filter((b) => b.slot < next),
    };
  }
  return { ...batch, nextBlock: next, transactions: batch.transactions.filter((t) => t.blockHeight < next) };
}

export type { EvmSource, BitcoinSource };
