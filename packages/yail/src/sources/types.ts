/**
 * Source abstraction. Every data provider (HyperSync, JSON-RPC, the cache
 * wrapper, Esplora for Bitcoin, Solana RPC, recorded fixtures) implements the
 * same shape: `getHeight()` and `fetch(query)` yielding ordered, contiguous
 * batches of blocks/transactions/logs for a block range.
 */

export interface FetchOptions {
  signal?: AbortSignal;
}

interface SourceBase {
  readonly name: string;
  getHeight(): Promise<number>;
  /**
   * First block the source holds data for. Absent means the whole chain. `union()` sends nothing below it, so a
   * source with partial history (Solana HyperSync keeps only recent slots) never gets a range it cannot serve.
   */
  firstBlock?(): Promise<number>;
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
  /** Part of the query's `join`: the transactions this filter matches come back whole. Other filters do not. */
  join?: boolean;
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
  /** OP-stack chains: the L1 data fee, paid on top of `gasUsed * effectiveGasPrice`. */
  l1Fee?: bigint;
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

export interface EvmSource extends SourceBase {
  readonly kind: "evm";
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

export interface BitcoinSource extends SourceBase {
  readonly kind: "bitcoin";
  fetch(query: BitcoinQuery, options?: FetchOptions): AsyncIterable<BitcoinBatch>;
}

// ---------------------------------------------------------------- Solana
// Blocks are slots: `fromBlock`/`toBlock`/`nextBlock` count slots.

export interface SolanaQuery extends RangeQuery {
  /** Wallets. Each one matches its own (SOL) account and every token account it owns. */
  addresses: string[];
}

export interface SolanaBlock {
  slot: number;
  /** Unix seconds. */
  time: number;
  hash?: string;
  parentHash?: string;
}

export interface SolanaTransaction {
  /** The transaction id (its first signature). */
  signature: string;
  slot: number;
  /** Order of the transaction inside its slot. */
  transactionIndex: number;
  feePayer: string;
  /** Lamports, charged to the fee payer even when the transaction failed. */
  fee: bigint;
  success: boolean;
}

/** One account whose SOL or tokens changed in one transaction, before and after. */
export interface SolanaBalance {
  signature: string;
  slot: number;
  transactionIndex: number;
  account: string;
  /** The account's lamports, when they changed. A token account holds its rent here, not its tokens. */
  lamports?: { pre: bigint; post: bigint };
  /** Set when the account is a token account: its tokens, in raw units. */
  token?: { mint: string; owner: string; decimals: number; pre: bigint; post: bigint };
}

export interface SolanaBatch extends RangeBatch {
  blocks: SolanaBlock[];
  transactions: SolanaTransaction[];
  /** Changed balances of the queried wallets' accounts only (their SOL account and the token accounts they own). */
  balances: SolanaBalance[];
}

export interface SolanaSource extends SourceBase {
  readonly kind: "solana";
  fetch(query: SolanaQuery, options?: FetchOptions): AsyncIterable<SolanaBatch>;
}

export type Source = EvmSource | BitcoinSource | SolanaSource;
export type SourceKind = Source["kind"];
export type QueryOf<S extends Source> = S extends EvmSource ? EvmQuery : S extends BitcoinSource ? BitcoinQuery : SolanaQuery;
export type BatchOf<S extends Source> = S extends EvmSource ? EvmBatch : S extends BitcoinSource ? BitcoinBatch : SolanaBatch;

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
