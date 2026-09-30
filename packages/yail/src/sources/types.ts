/**
 * Source abstraction. Every data provider (HyperSync, JSON-RPC, the cache
 * wrapper, Esplora for Bitcoin, recorded fixtures) implements the same
 * shape: `getHeight()` and `fetch(query)` yielding ordered, contiguous
 * batches of blocks/transactions/logs for a block range.
 */

export interface FetchOptions {
  signal?: AbortSignal;
}

export interface RangeQuery {
  fromBlock: number;
  /** Exclusive. */
  toBlock: number;
}

export interface RangeBatch {
  fromBlock: number;
  /** Exclusive end of the range covered by this batch. Contiguous with the next batch. */
  nextBlock: number;
}

// ---------------------------------------------------------------- EVM

export interface EvmLogFilter {
  /** Contract addresses (OR). Empty/undefined = any contract. */
  address?: string[];
  /** Per-position topic alternatives (OR within a position, AND across positions). `null` = any. */
  topics?: Array<string[] | null>;
}

export interface EvmTxFilter {
  /** Sender addresses (OR). */
  from?: string[];
  /** Recipient addresses (OR). Combined with `from` using AND (HyperSync semantics). */
  to?: string[];
}

export interface EvmTraceFilter {
  /** Caller addresses (OR). */
  from?: string[];
  /** Callee addresses (OR). Combined with `from` using AND (HyperSync semantics). */
  to?: string[];
}

export interface EvmQuery extends RangeQuery {
  logs: EvmLogFilter[];
  transactions: EvmTxFilter[];
  /** Call traces to match. Only trace-enabled sources return any (HyperSync `*-traces` endpoints). */
  traces?: EvmTraceFilter[];
  /** Also return the transaction of every matched log. */
  includeLogTransactions?: boolean;
  /** Return each matched transaction whole: the transaction, all of its logs and all of its traces. */
  join?: boolean;
}

export interface EvmBlock {
  number: number;
  hash: string;
  parentHash?: string;
  timestamp: number;
}

export interface EvmTransaction {
  hash: string;
  blockNumber: number;
  transactionIndex: number;
  from: string;
  to: string | null;
  value: bigint;
  input: string;
  nonce?: bigint;
  gas?: bigint;
  gasPrice?: bigint;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  status?: number;
  type?: number;
  contractAddress?: string | null;
}

export interface EvmLog {
  blockNumber: number;
  blockHash?: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  address: string;
  data: string;
  topics: string[];
  removed?: boolean;
}

/** One call frame of a transaction (Parity-style trace). */
export interface EvmTrace {
  transactionHash: string;
  blockNumber: number;
  /** Position in the call tree: `[]` is the transaction's own call, `[0, 2]` the third call made by its first call. */
  traceAddress: number[];
  /** "call", "create", "suicide" or "reward". */
  type: string;
  /** For calls: "call", "delegatecall", "staticcall" or "callcode". */
  callType?: string;
  from: string;
  to: string | null;
  value: bigint;
  /** Set when the frame reverted; its sub-calls are reverted with it. */
  error?: string;
}

export interface RollbackGuard {
  blockNumber: number;
  hash: string;
  firstBlockNumber: number;
  firstParentHash: string;
}

export interface EvmBatch extends RangeBatch {
  blocks: EvmBlock[];
  transactions: EvmTransaction[];
  logs: EvmLog[];
  traces?: EvmTrace[];
  rollbackGuard?: RollbackGuard;
  archiveHeight?: number;
}

export interface EvmSource {
  readonly kind: "evm";
  readonly name: string;
  getHeight(): Promise<number>;
  fetch(query: EvmQuery, options?: FetchOptions): AsyncIterable<EvmBatch>;
  /** Optional: block header lookup (used for reorg checks and `startBlock: "latest"`). */
  getBlock?(number: number): Promise<EvmBlock | null>;
}

// ---------------------------------------------------------------- Bitcoin

export interface BitcoinQuery extends RangeQuery {
  addresses: string[];
}

export interface BitcoinOutput {
  n: number;
  address: string | null;
  value: bigint;
  scriptType?: string;
}

export interface BitcoinInput {
  txid: string;
  vout: number;
  prevout: { address: string | null; value: bigint } | null;
  isCoinbase: boolean;
}

export interface BitcoinTransaction {
  txid: string;
  blockHeight: number;
  blockHash: string;
  blockTime: number;
  fee: bigint;
  vin: BitcoinInput[];
  vout: BitcoinOutput[];
}

export interface BitcoinBatch extends RangeBatch {
  transactions: BitcoinTransaction[];
}

export interface BitcoinSource {
  readonly kind: "bitcoin";
  readonly name: string;
  getHeight(): Promise<number>;
  fetch(query: BitcoinQuery, options?: FetchOptions): AsyncIterable<BitcoinBatch>;
}

export type Source = EvmSource | BitcoinSource;
export type SourceKind = Source["kind"];
export type QueryOf<S extends Source> = S extends EvmSource ? EvmQuery : BitcoinQuery;
export type BatchOf<S extends Source> = S extends EvmSource ? EvmBatch : BitcoinBatch;

/** Sort key for deterministic ordering of logs within a chain. */
export function logOrder(a: EvmLog, b: EvmLog): number {
  return a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex;
}
export function txOrder(a: EvmTransaction, b: EvmTransaction): number {
  return a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex;
}

export function lower(s: string): string {
  return s.toLowerCase();
}
