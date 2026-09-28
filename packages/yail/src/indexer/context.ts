import type { Abi } from "viem";
import type { AddressRegistry, AddressRow } from "../addresses/registry.js";
import type { Db } from "../db/client.js";
import { BatchWriter } from "../db/batch.js";
import type { RowMeta } from "../db/serialize.js";
import type { HttpClient } from "../http/client.js";
import type { CachedClient } from "../rpc/cached-client.js";
import type { InferRow, InsertRow, Table } from "../schema/table.js";
import type { WideLogger } from "../observability/logger.js";
import type { Config } from "../config/types.js";
import { toArray } from "../util.js";

/** `context.db`: same as `Db` but inserts are buffered and flushed per batch. */
export interface HandlerDb extends Omit<Db, "insert"> {
  /** Buffered insert. Rows become visible in ClickHouse after the batch flushes (before the checkpoint is written). */
  insert<T extends Table<any>>(table: T): { values(rows: InsertRow<T> | InsertRow<T>[]): void };
  /** Buffer-aware lookup: returns the latest row written in this batch for the key, else reads ClickHouse (FINAL). */
  find<T extends Table<any>>(table: T, key: Partial<InferRow<T>>): Promise<InferRow<T> | null>;
  /** Force a flush now (rarely needed). */
  flush(): Promise<void>;
}

export interface AddressesApi {
  /** Is the address a live or pending member of the set on the current chain? */
  has(set: string, address: string, chain?: string): boolean;
  /** Register an address for backfill + live indexing. Idempotent. */
  register(set: string, address: string, options?: { chain?: string; fromBlock?: number; meta?: Record<string, unknown> }): Promise<AddressRow>;
  list(set: string, chain?: string): AddressRow[];
}

export interface HandlerContext<C extends Config<any, any, any> = Config<any, any, any>, chain extends string = string> {
  chain: { name: chain; id: number | string; kind: "evm" | "bitcoin" };
  db: HandlerDb;
  /** Cached contract reads; only defined for EVM chains with `rpc` configured. */
  client: CachedClient | undefined;
  http: HttpClient;
  addresses: AddressesApi;
  /** ABIs and static addresses from the config, for `client.readContract`. */
  contracts: { [K in keyof NonNullable<C["contracts"]> & string]: { abi: NonNullable<C["contracts"]>[K]["abi"]; address?: string } };
  /** evlog wide-event logger for the current batch. `log.set({...})` adds fields to the batch event. */
  log: WideLogger;
  /** True while running an address backfill or re-index job (vs. the live loop). */
  backfill: boolean;
}

export interface ContextDeps {
  db: Db;
  writer: BatchWriter;
  registry: AddressRegistry;
  http: HttpClient;
  client: CachedClient | undefined;
  chain: { name: string; id: number | string; kind: "evm" | "bitcoin" };
  contracts: Record<string, { abi: Abi; address?: string }>;
  defaultFromBlock: (set: string) => number;
  log: WideLogger;
  backfill: boolean;
  /** Set by the runtime before each handler call. */
  meta: { current: RowMeta };
}

export function createHandlerDb(db: Db, writer: BatchWriter, meta: { current: RowMeta }): HandlerDb {
  const handlerDb: HandlerDb = {
    ...db,
    insert(table) {
      return {
        values(rows) {
          for (const r of toArray<any>(rows)) writer.add(table, r, meta.current);
        },
      };
    },
    async find(table, key) {
      const buffered = writer.peek(table, key);
      if (buffered) return buffered;
      return db.find(table, key);
    },
    async flush() {
      await writer.flush();
    },
  };
  return handlerDb;
}

export function createContext(deps: ContextDeps): HandlerContext<any, string> {
  return {
    chain: deps.chain,
    db: createHandlerDb(deps.db, deps.writer, deps.meta),
    client: deps.client,
    http: deps.http,
    addresses: {
      has: (set, address, chain) => deps.registry.has(set, chain ?? deps.chain.name, address),
      register: (set, address, options) =>
        deps.registry
          .register({ set, chain: options?.chain ?? deps.chain.name, address, fromBlock: options?.fromBlock ?? deps.defaultFromBlock(set), meta: options?.meta })
          .then((rows) => rows[0]!),
      list: (set, chain) => deps.registry.list({ set, chain: chain ?? deps.chain.name }),
    },
    contracts: deps.contracts as any,
    log: deps.log,
    backfill: deps.backfill,
  };
}

export { BatchWriter };
