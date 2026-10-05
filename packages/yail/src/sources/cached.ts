import { createHash } from "node:crypto";
import type { Db } from "../db/client.js";
import { sql } from "../db/sql.js";
import { sourceCache } from "../db/internal.js";
import type { BitcoinSource, EvmSource, FetchOptions, RangeBatch, RangeQuery, Source } from "./types.js";

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
  const evmInner = inner as EvmSource;
  const wrapped: Record<string, unknown> = {
    kind: inner.kind,
    name: `cached(${inner.name})`,
    getHeight: () => inner.getHeight(),
    async *fetch(query: RangeQuery, fetchOptions?: FetchOptions): AsyncIterable<RangeBatch> {
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
            const batch = reviveBatch(payload) as RangeBatch;
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
        for await (const batch of (inner as EvmSource).fetch({ ...(query as any), fromBlock: cursor, toBlock: missEnd }, fetchOptions)) {
          const b = batch as unknown as RangeBatch;
          if (finalized === undefined || b.nextBlock - 1 <= finalized) {
            await options.db.insert(sourceCache).values({
              chain: options.chain,
              queryHash,
              fromBlock: BigInt(b.fromBlock),
              nextBlock: BigInt(b.nextBlock),
              payload: serializeBatch(b),
              createdAt: new Date(),
            });
            options.onEvent?.({ type: "store", fromBlock: b.fromBlock, nextBlock: b.nextBlock });
          }
          yield b;
          cursor = b.nextBlock;
        }
        if (cursor < missEnd) throw new Error(`cached(${inner.name}): inner source stopped at ${cursor} before ${missEnd}`);
      }
    },
  };
  if (evmInner.getBlock) wrapped.getBlock = (n: number) => evmInner.getBlock!(n);
  if (inner.firstBlock) wrapped.firstBlock = () => inner.firstBlock!();
  return wrapped as unknown as S;
}

/** Hash of the query minus its block range. */
export function hashQuery(query: RangeQuery): string {
  const { fromBlock: _f, toBlock: _t, ...shape } = query as unknown as Record<string, unknown>;
  const json = JSON.stringify(shape, (_k, v) => {
    if (typeof v === "string") return hexLower(v);
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return [...v].map(hexLower).sort();
    return v;
  });
  return createHash("sha256").update(json).digest("hex").slice(0, 32);
}

/** Hex is case-insensitive; base58 addresses (Solana, legacy Bitcoin) are not. */
function hexLower(s: string): string {
  if (s.startsWith("0x")) return s.toLowerCase();
  return s;
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
  if (value && typeof value === "object" && typeof (value as { $big?: unknown }).$big === "string") return BigInt((value as { $big: string }).$big);
  return value;
}

function clampBatch(batch: RangeBatch, next: number): RangeBatch {
  if (batch.nextBlock === next) return batch;
  const b: any = { ...batch, nextBlock: next };
  for (const key of ["blocks", "transactions", "logs", "traces", "balances"]) {
    if (Array.isArray(b[key])) b[key] = b[key].filter((x: any) => (x.number ?? x.blockNumber ?? x.blockHeight ?? x.slot) < next);
  }
  return b;
}

export type { EvmSource, BitcoinSource };
