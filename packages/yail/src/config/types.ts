import type { Abi } from "viem";
import type { DatabaseConfig } from "../db/client.js";
import type { Source } from "../sources/types.js";
import type { AddressSetRef, FactoryRef } from "./address.js";
import type { CacheStore } from "../cache/cached.js";
import type { EventDef, InstructionDef } from "../solana/program.js";

export type AddressSpec = string | readonly string[] | AddressSetRef | FactoryRef;

export interface ChainConfig<S extends Source = Source> {
  /** Chain id (EVM) or a string id such as "bitcoin" or "solana". */
  id: number | string;
  /** Data source: `hypersync()`, `rpc()` (EVM, or Solana with `kind: "solana"`), `esplora()`, a `union()` of one chain's sources, or any of them wrapped in `cached()`. */
  source: S;
  /**
   * Source for address history: `backfill_address` and `reindex_scope` jobs read through it, the live loop and
   * `reindex_range` through `source`. Same kind as `source`. Default: `source`.
   */
  backfillSource?: S;
  /** Optional JSON-RPC URL, enables `context.client.readContract` (EVM only). */
  rpc?: string;
  /** Blocks behind the source head treated as final. Default: 20 (EVM), 3 (Bitcoin), 32 slots (Solana). */
  finality?: number;
  /** Poll interval in ms once caught up. Default: 2000 (EVM), 30000 (Bitcoin). */
  pollInterval?: number;
  /** Max blocks per planned query. Default: 100000 (HyperSync), 2000 (RPC), 50000 (Bitcoin), 5000000 slots (Solana). */
  maxBlockRange?: number;
}

export type BlockRef = number | "latest";

export interface EventFilterArgs {
  [param: string]: string | number | bigint | boolean | ReadonlyArray<string | number | bigint | boolean> | AddressSetRef;
}

export interface EventFilter<eventName extends string = string> {
  event: eventName;
  args: EventFilterArgs;
}

export interface ChainScopedContract {
  address?: AddressSpec;
  startBlock?: BlockRef;
  endBlock?: number;
  filter?: EventFilter | readonly EventFilter[];
}

export interface ContractConfig<abi extends Abi = Abi> {
  abi: abi;
  /** Chain name, or a per-chain map of overrides (Ponder style). */
  chain: string | Readonly<Record<string, ChainScopedContract>>;
  /** Static address(es), an `addressSet()`, or a `factory()`. Omit to match every contract. */
  address?: AddressSpec;
  startBlock?: BlockRef;
  endBlock?: number;
  /** Only index logs matching these indexed-argument filters (OR between filters). Values may be `addressSet()` refs. */
  filter?: EventFilter | readonly EventFilter[];
  /** Attach `event.transaction` to every event (extra data from the source). Default false. */
  includeTransactions?: boolean;
}

export interface ChainScopedAccount {
  address?: AddressSpec;
  startBlock?: BlockRef;
  endBlock?: number;
}

/** Index transactions sent from/to a set of addresses (EVM native transfers, Bitcoin UTXO movements, Solana SOL and token balance changes). */
export interface AccountConfig {
  chain: string | Readonly<Record<string, ChainScopedAccount>>;
  address: AddressSpec;
  startBlock?: BlockRef;
  endBlock?: number;
  /**
   * Also match transactions that only mention the address: in an indexed log topic or as a call trace's
   * sender or recipient (traces need a trace-enabled source). Events then carry every log and trace of the
   * transaction. EVM only; needs HyperSync.
   */
  activity?: boolean;
}

export interface ChainScopedProgram {
  address?: string | readonly string[];
  startBlock?: BlockRef;
  endBlock?: number;
}

/**
 * A Solana program: the instructions it runs and the events it emits, decoded with the codecs of
 * `@notuslabs/yail/solana`. Served by `hypersync({ kind: "solana" })` only, from the first slot it holds.
 */
export interface ProgramConfig<
  instructions extends Record<string, InstructionDef<any, any>> = Record<string, InstructionDef<any, any>>,
  events extends Record<string, EventDef<any>> = Record<string, EventDef<any>>,
> {
  /** Solana chain name, or a per-chain map of overrides. `{}` indexes nothing and keeps the handlers typed. */
  chain: string | Readonly<Record<string, ChainScopedProgram>>;
  /** Program id(s), base58. */
  address: string | readonly string[];
  /** At or above the first slot Solana HyperSync holds: `rpc({ kind: "solana" })` refuses program queries. */
  startBlock?: BlockRef;
  endBlock?: number;
  instructions?: instructions;
  events?: events;
  /** Where the events are: `Program data:` log lines (`emit!`, the default) or self-CPI inner instructions (`emit_cpi!`). */
  emit?: "log" | "cpi";
  /** Give instruction events the program's log lines in their transaction (`event.programLogs`). */
  includeLogs?: boolean;
  /** Give events every SOL and token balance change of their transaction (`event.balances`). About 6.5x the data. */
  includeBalances?: boolean;
}

export interface AddressSetConfig {
  /** Addresses to seed the set with (registered on first start, per chain that uses the set). */
  initial?: ReadonlyArray<string | { address: string; chain?: string; fromBlock?: number }>;
}

export interface CacheConfig {
  /** Where `context.cache` answers live: `memory()` (default, the process) or `redis({ url })`. */
  store?: CacheStore;
  /** Cache raw source batches in ClickHouse (`_yail_source_cache`). Same effect as wrapping sources in `cached()`. */
  source?: boolean;
  /** Persist `context.http` responses in ClickHouse. Default true. */
  http?: boolean;
  /** Persist `context.client.readContract` results in ClickHouse. Default true. */
  rpc?: boolean;
}

export interface ObservabilityConfig {
  /** Service name for logs/metrics/traces. Default: "yail". */
  serviceName?: string;
  /** OTLP HTTP endpoint (base URL). Falls back to OTEL_EXPORTER_OTLP_ENDPOINT / OTLP_ENDPOINT. */
  otlpEndpoint?: string;
  otlpHeaders?: Record<string, string>;
  /** Pretty console output. Default: true outside production. */
  pretty?: boolean;
  logLevel?: "debug" | "info" | "warn" | "error";
  /** Also store wide events in ClickHouse table `_yail_logs` (queryable observability with zero extra infra). Default false. */
  logsToClickHouse?: boolean;
  /** Emit one wide event per source batch. Default true. */
  batchEvents?: boolean;
}

export interface ServerConfig {
  /** Port for the status/admin HTTP API. Default 42069. `false` disables the server. */
  port?: number | false;
  hostname?: string;
}

export interface IndexingConfig {
  /** Flush buffered rows when this many are pending, even mid-batch. Default 50000. */
  flushMaxRows?: number;
  /** How many address-backfill / reindex jobs run concurrently per chain. Default 2. */
  jobConcurrency?: number;
  /** Max addresses per source filter chunk. Default 500. */
  addressChunk?: number;
}

export interface Config<
  chains extends Record<string, ChainConfig> = Record<string, ChainConfig>,
  contracts extends Record<string, ContractConfig<any>> = Record<string, ContractConfig<any>>,
  accounts extends Record<string, AccountConfig> = Record<string, AccountConfig>,
  programs extends Record<string, ProgramConfig<any, any>> = Record<string, ProgramConfig<any, any>>,
> {
  database: DatabaseConfig;
  chains: chains;
  contracts?: contracts;
  accounts?: accounts;
  programs?: programs;
  addressSets?: Record<string, AddressSetConfig>;
  cache?: CacheConfig;
  observability?: ObservabilityConfig;
  server?: ServerConfig;
  indexing?: IndexingConfig;
}
