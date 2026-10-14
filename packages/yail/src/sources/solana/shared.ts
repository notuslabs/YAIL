import type { SolanaBalance, SolanaBatch, SolanaBlock, SolanaTransaction } from "../types.js";

/** The wallet a balance row belongs to: a token account's owner, otherwise the account itself. */
export function walletOf(b: Pick<SolanaBalance, "account" | "token">): string {
  if (b.token) return b.token.owner;
  return b.account;
}

/** A balance row, with `lamports` only when they changed: every Solana source reports the same rows. */
export function solanaBalance(at: Pick<SolanaBalance, "signature" | "slot" | "transactionIndex" | "account">, preLamports: bigint, postLamports: bigint, token?: SolanaBalance["token"]): SolanaBalance {
  const balance: SolanaBalance = { ...at };
  if (preLamports !== postLamports) balance.lamports = { pre: preLamports, post: postLamports };
  if (token) balance.token = token;
  return balance;
}

/** Lexicographic order of instruction addresses: `[2] < [2, 0] < [2, 1] < [3]`. */
export function compareAddress(a: readonly number[], b: readonly number[]): number {
  for (const [i, n] of a.entries()) {
    const m = b[i];
    if (m === undefined) return 1;
    if (n !== m) return n - m;
  }
  return a.length - b.length;
}

/**
 * Keep the rows where something changed and the transactions and blocks they belong to, in chain order. Sources
 * disagree on unchanged accounts (RPC lists every account a transaction touches, HyperSync only some), so they
 * are dropped and every source answers the same. Program rows of failed transactions are dropped too: HyperSync
 * keeps none, and a log line written before the failure must never reach a handler.
 */
export function finishBatch(batch: SolanaBatch): SolanaBatch {
  const order = (a: { slot: number; transactionIndex: number }, b: { slot: number; transactionIndex: number }) => a.slot - b.slot || a.transactionIndex - b.transactionIndex;
  const changed = (b: SolanaBalance) => b.lamports !== undefined || (b.token !== undefined && b.token.pre !== b.token.post);
  const failed = new Set(batch.transactions.filter((t) => !t.success).map((t) => t.signature));
  const succeeded = (row: { signature: string }) => !failed.has(row.signature);
  batch.balances = batch.balances.filter(changed).sort(order);
  batch.instructions = batch.instructions.filter(succeeded).sort((a, b) => order(a, b) || compareAddress(a.address, b.address));
  batch.logs = batch.logs.filter(succeeded).sort(order);
  batch.joinedBalances = batch.joinedBalances.filter((b) => succeeded(b) && changed(b)).sort(order);
  const signatures = new Set([...batch.balances, ...batch.instructions, ...batch.logs, ...batch.joinedBalances].map((row) => row.signature));
  batch.transactions = batch.transactions.filter((t: SolanaTransaction) => signatures.has(t.signature)).sort(order);
  const slots = new Set(batch.transactions.map((t) => t.slot));
  batch.blocks = batch.blocks.filter((b: SolanaBlock) => slots.has(b.slot)).sort((a, b) => a.slot - b.slot);
  return batch;
}
