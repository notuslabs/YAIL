import type { Abi } from "viem";
import type { DatabaseConfig } from "../db/client.js";
import type { Source } from "../sources/types.js";
import type { AddressSetRef, FactoryRef } from "./address.js";
import type { LookupCache } from "../lookups/lookup.js";

export type AddressSpec = string | readonly string[] | AddressSetRef | FactoryRef;

export interface ChainConfig<S extends Source = Source> {
  /** Chain id (EVM) or a string id such as "bitcoin". */
  id: number | string;
  /** Data source: `hypersync()`, `rpc()`, `esplora()`, or any of them wrapped in `cached()`. */
  source: S;
  /** Optional JSON-RPC URL, enables `context.client.readContract` (EVM only). */
  rpc?: string;
  /** Blocks behind the source head treated as final. Default: 20 (EVM), 3 (Bitcoin). */
  finality?: number;
  /** Poll interval in ms once caught up. Default: 2000 (EVM), 30000 (Bitcoin). */
  pollInterval?: number;
  /** Max blocks per planned query. Default: 100000 (HyperSync), 2000 (RPC), 50000 (Bitcoin). */
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

/** Index transactions sent from/to a set of addresses (EVM native transfers, Bitcoin UTXO movements). */
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

export interface AddressSetConfig {
  /** Addresses to seed the set with (registered on first start, per chain that uses the set). */
  initial?: ReadonlyArray<string | { address: string; chain?: string; fromBlock?: number }>;
}

export interface CacheConfig {
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

export interface LookupsConfig {
  /** Where `context.lookup` answers live: `memory()` (default, the process) or `redis({ url })`. */
  cache?: LookupCache;
}

export interface Config<
  chains extends Record<string, ChainConfig> = Record<string, ChainConfig>,
  contracts extends Record<string, ContractConfig<any>> = Record<string, ContractConfig<any>>,
  accounts extends Record<string, AccountConfig> = Record<string, AccountConfig>,
> {
  database: DatabaseConfig;
  chains: chains;
  contracts?: contracts;
  accounts?: accounts;
  addressSets?: Record<string, AddressSetConfig>;
  cache?: CacheConfig;
  observability?: ObservabilityConfig;
  server?: ServerConfig;
  indexing?: IndexingConfig;
  lookups?: LookupsConfig;
}
