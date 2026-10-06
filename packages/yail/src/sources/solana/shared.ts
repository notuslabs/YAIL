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

/**
 * Keep the rows where something changed and the transactions and blocks they belong to, in chain order. Sources
 * disagree on unchanged accounts (RPC lists every account a transaction touches, HyperSync only some), so they
 * are dropped and every source answers the same.
 */
export function finishBatch(batch: SolanaBatch): SolanaBatch {
  const order = (a: { slot: number; transactionIndex: number }, b: { slot: number; transactionIndex: number }) => a.slot - b.slot || a.transactionIndex - b.transactionIndex;
  batch.balances = batch.balances.filter((b) => b.lamports || (b.token && b.token.pre !== b.token.post)).sort(order);
  const signatures = new Set(batch.balances.map((b) => b.signature));
  batch.transactions = batch.transactions.filter((t: SolanaTransaction) => signatures.has(t.signature)).sort(order);
  const slots = new Set(batch.transactions.map((t) => t.slot));
  batch.blocks = batch.blocks.filter((b: SolanaBlock) => slots.has(b.slot)).sort((a, b) => a.slot - b.slot);
  return batch;
}
