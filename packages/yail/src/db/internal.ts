import { t, table } from "../schema/index.js";

/** Per-chain indexing progress. `cursor` is the next block to index. */
export const checkpoints = table(
  "_yail_checkpoints",
  {
    chain: t.string(),
    cursor: t.uint64(),
    head: t.uint64(),
    updatedAt: t.dateTime64(3),
  },
  { orderBy: ["chain"], engineArgs: ["updated_at"], indexMeta: false },
);

/** Dynamic address registry. One row per (set, chain, address); latest version wins. */
export const addresses = table(
  "_yail_addresses",
  {
    set: t.string(),
    chain: t.string(),
    address: t.address(),
    status: t.enum(["pending", "backfilling", "live", "failed"]),
    /** First block the address should be indexed from. */
    fromBlock: t.uint64(),
    /** True once the live loop has adopted the address (it is included in live queries from `adoptedAtBlock` on). */
    adopted: t.bool().default("false"),
    /** Block at which the live loop adopted the address; backfill covers [fromBlock, adoptedAtBlock). */
    adoptedAtBlock: t.uint64(),
    /** Optional user-defined label / metadata (JSON). */
    meta: t.json<Record<string, unknown>>().default("'{}'"),
    error: t.string().default("''"),
    registeredAt: t.dateTime64(3),
    updatedAt: t.dateTime64(3),
  },
  { orderBy: ["set", "chain", "address"], engineArgs: ["updated_at"], indexMeta: false },
);

/** Durable job queue: address backfills and range re-indexes. */
export const jobs = table(
  "_yail_jobs",
  {
    id: t.string(),
    chain: t.string(),
    kind: t.enum(["backfill_address", "reindex_range", "reindex_scope"]),
    payload: t.json<Record<string, unknown>>(),
    status: t.enum(["pending", "running", "done", "failed"]),
    attempts: t.uint32().default("0"),
    error: t.string().default("''"),
    createdAt: t.dateTime64(3),
    updatedAt: t.dateTime64(3),
  },
  { orderBy: ["id"], engineArgs: ["updated_at"], indexMeta: false },
);

/** Optional cache of raw source batches (HyperSync/RPC pages), keyed by query shape. */
export const sourceCache = table(
  "_yail_source_cache",
  {
    chain: t.string(),
    queryHash: t.string(),
    fromBlock: t.uint64(),
    nextBlock: t.uint64(),
    payload: t.string().codec("ZSTD(3)"),
    createdAt: t.dateTime64(3),
  },
  { orderBy: ["chain", "queryHash", "fromBlock"], engineArgs: ["created_at"], indexMeta: false },
);

/** Cached HTTP responses for `context.http`. */
export const httpCache = table(
  "_yail_http_cache",
  {
    key: t.string(),
    url: t.string(),
    status: t.uint16(),
    headers: t.string().codec("ZSTD(3)"),
    body: t.string().codec("ZSTD(3)"),
    fetchedAt: t.dateTime64(3),
    expiresAt: t.dateTime64(3),
  },
  { orderBy: ["key"], engineArgs: ["fetched_at"], indexMeta: false },
);

/** Cached `eth_call` results for `context.client.readContract`, keyed by block. */
export const rpcCache = table(
  "_yail_rpc_cache",
  {
    chain: t.string(),
    block: t.uint64(),
    to: t.address(),
    data: t.string(),
    result: t.string(),
    createdAt: t.dateTime64(3),
  },
  { orderBy: ["chain", "block", "to", "data"], engineArgs: ["created_at"], indexMeta: false },
);

/** Recent block hashes per chain, used to detect reorgs against the source's rollback guard. */
export const blockHashes = table(
  "_yail_block_hashes",
  {
    chain: t.string(),
    block: t.uint64(),
    hash: t.hash(),
    createdAt: t.dateTime64(3),
  },
  { orderBy: ["chain", "block"], engineArgs: ["created_at"], indexMeta: false, ttl: "created_at + INTERVAL 7 DAY" },
);

export const INTERNAL_TABLES = [checkpoints, addresses, jobs, sourceCache, httpCache, rpcCache, blockHashes];
