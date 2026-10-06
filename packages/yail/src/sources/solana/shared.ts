import type { SolanaBalance, SolanaBatch, SolanaBlock, SolanaTransaction } from "../types.js";

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

/** HTTP with retries on 429, 5xx and network errors. */
export async function request(doFetch: typeof fetch, url: string, init: RequestInit): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await doFetch(url, init);
      if (res.ok) return await res.text();
      const body = await res.text().catch(() => "");
      if (res.status !== 429 && res.status < 500) throw new HttpError(`${url}: HTTP ${res.status} ${body.slice(0, 300)}`);
      if (attempt === 12) throw new Error(`${url}: HTTP ${res.status} after ${attempt} attempts`);
    } catch (err) {
      if (err instanceof HttpError || init.signal?.aborted || attempt === 12) throw err;
    }
    await sleep(Math.min(30_000, 250 * 2 ** attempt), init.signal ?? undefined);
  }
}

class HttpError extends Error {}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });
}
