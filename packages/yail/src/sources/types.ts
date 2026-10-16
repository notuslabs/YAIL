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
  /**
   * Calls `listener` before each request the source sends: every HTTP attempt, retries included (for EVM
   * `hypersync()`, every call of its client and every response of its stream, but not the retries its client makes on
   * its own). Covers the sources it wraps. Returns the function that removes the listener. The indexer counts them in
   * `/status` (`sourceRequests`).
   */
  onRequest?(listener: () => void): () => void;
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
  /**
   * Read the range's blocks whole and keep the transactions of `addresses`: the same answer, at a cost that grows with
   * the blocks instead of the addresses. Set by the live loop within the chain's `wholeBlocksWithin` of the head;
   * a source that cannot read whole blocks ignores it.
   */
  wholeBlocks?: boolean;
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

/** Instructions of Solana programs, top-level or inner (CPI), of successful transactions. */
export interface SolanaInstructionFilter {
  /** Program ids (OR). */
  programs: string[];
  /** Hex prefixes of the instruction data (OR), 1, 2, 4 or 8 bytes each. Empty = every instruction of the programs. */
  discriminators: string[];
  /** true = inner (CPI) instructions only, false = top-level ones only. Absent = both. */
  isInner?: boolean;
  /**
   * Also the log lines of these kinds the programs wrote in each matched transaction, in the same request (HyperSync
   * intersects the two per transaction: a transaction where the programs wrote no such line matches nothing). Empty = none.
   */
  logKinds: Array<"log" | "data">;
  /** Also every balance change of each matched transaction (`joinedBalances`). */
  balances: boolean;
}

/** Log lines Solana programs wrote in successful transactions. */
export interface SolanaLogFilter {
  /** Program ids (OR). */
  programs: string[];
  /** `log` for `Program log:` lines, `data` for `Program data:` lines (Anchor `emit!` events). */
  kinds: Array<"log" | "data">;
  /** Also every balance change of each matched transaction (`joinedBalances`). */
  balances: boolean;
}

export interface SolanaQuery extends RangeQuery {
  /** Wallets. Each one matches its own (SOL) account and every token account it owns. */
  addresses: string[];
  /** Program instructions. Only `hypersync({ kind: "solana" })` serves them. */
  instructions?: SolanaInstructionFilter[];
  /** Program log lines. Only `hypersync({ kind: "solana" })` serves them. */
  logs?: SolanaLogFilter[];
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

/** One instruction a successful transaction ran: a top-level one or an inner (CPI) one. */
export interface SolanaInstruction {
  signature: string;
  slot: number;
  transactionIndex: number;
  /** Position in the transaction: `[2]` is its third top-level instruction, `[2, 0]` the first inner one that one made. */
  address: number[];
  program: string;
  accounts: string[];
  /** Hex, without `0x`. */
  data: string;
  isInner: boolean;
}

/** One log line a program wrote in a successful transaction. */
export interface SolanaLog {
  signature: string;
  slot: number;
  transactionIndex: number;
  /** The instruction that wrote it. Null before slot 416,000,000: Solana HyperSync did not record it there. */
  instructionAddress: number[] | null;
  /** The program that wrote it, an inner (CPI) one included. */
  program: string;
  kind: "log" | "data";
  /** Without the `Program log: ` / `Program data: ` prefix (a `data` line is bare base64). */
  message: string;
}

export interface SolanaBatch extends RangeBatch {
  blocks: SolanaBlock[];
  transactions: SolanaTransaction[];
  /** Changed balances of the queried wallets' accounts only (their SOL account and the token accounts they own). */
  balances: SolanaBalance[];
  /** By transaction, then by address. */
  instructions: SolanaInstruction[];
  /** By transaction, then in the order they were written. */
  logs: SolanaLog[];
  /** Changed balances of every account in the transactions a program filter with `balances: true` matched. */
  joinedBalances: SolanaBalance[];
}

export interface SolanaSource extends SourceBase {
  readonly kind: "solana";
  fetch(query: SolanaQuery, options?: FetchOptions): AsyncIterable<SolanaBatch>;
}

export type Source = EvmSource | BitcoinSource | SolanaSource;
export type SourceKind = Source["kind"];
export type QueryOf<S extends Source> = S extends EvmSource ? EvmQuery : S extends BitcoinSource ? BitcoinQuery : SolanaQuery;
export interface BatchByKind {
  evm: EvmBatch;
  bitcoin: BitcoinBatch;
  solana: SolanaBatch;
}
export type BatchOf<S extends Source> = BatchByKind[S["kind"]];

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
