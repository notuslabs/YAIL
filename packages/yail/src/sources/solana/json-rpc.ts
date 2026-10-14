import type { SolanaBalance, SolanaBatch, SolanaBlock, SolanaQuery, SolanaTransaction } from "../types.js";
import { mapLimit, request } from "../../util.js";
import { solanaBalance, walletOf } from "./shared.js";

interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

/** A transaction as Solana JSON-RPC returns it with `encoding: "json"`, from `getTransaction` or Helius's `getTransactionsForAddress`. */
export interface RawTransaction {
  slot: number;
  blockTime: number | null;
  /** Position in the slot. Mainnet's `getTransaction` returns it (2026-10) but it is not documented: read from `getBlock` when absent. */
  transactionIndex?: number;
  transaction: { signatures: string[]; message: { accountKeys: string[] } };
  meta: {
    err: unknown;
    fee: number | bigint;
    preBalances: Array<number | bigint>;
    postBalances: Array<number | bigint>;
    preTokenBalances?: RawTokenBalance[];
    postTokenBalances?: RawTokenBalance[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
  };
}

export type JsonRpcCall = <T>(method: string, params: unknown[], signal?: AbortSignal) => Promise<T>;

export interface JsonRpcOptions {
  url: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

/** Calls to the JSON-RPC node at `options.url`; its errors start with `name`. */
export function jsonRpc(name: string, options: JsonRpcOptions): JsonRpcCall {
  const doFetch = options.fetch ?? fetch;
  let id = 0;
  return async function call<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
    const init = { method: "POST", headers: { "Content-Type": "application/json", ...options.headers }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal };
    const text = await request(doFetch, options.url, init);
    // Lamports can pass 2^53: keep such numbers exact.
    const res = JSON.parse(text, (_key, value, context?: { source?: string }) => {
      if (typeof value === "number" && !Number.isSafeInteger(value) && context?.source && /^\d+$/.test(context.source)) return BigInt(context.source);
      return value;
    }) as { result?: T; error?: { code: number; message: string } };
    if (res.error) throw new Error(`${name} ${method}: ${res.error.code} ${res.error.message}`);
    return res.result as T;
  };
}

export function accountKeys(raw: RawTransaction): string[] {
  const loaded = raw.meta.loadedAddresses;
  return [...raw.transaction.message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
}

/** Fill `transactionIndex` where the provider left it out: one `getBlock` (signatures only) per such slot. */
export async function orderInSlots(raws: RawTransaction[], call: JsonRpcCall, concurrency: number, signal?: AbortSignal): Promise<void> {
  const slots = [...new Set(raws.filter((r) => r.transactionIndex === undefined).map((r) => r.slot))];
  const blocks = await mapLimit(slots, concurrency, (slot) =>
    call<{ signatures: string[] }>("getBlock", [slot, { transactionDetails: "signatures", rewards: false, maxSupportedTransactionVersion: 1, commitment: "confirmed" }], signal),
  );
  const index = new Map(blocks.flatMap((b) => b.signatures.map((sig, i) => [sig, i] as const)));
  for (const raw of raws) raw.transactionIndex ??= index.get(raw.transaction.signatures[0]!);
}

/** The wallets' rows of `raws`, before `finishBatch`. A token balance without its owner (before slot 111,491,819) takes it from `owners`. */
export function toBatch(raws: RawTransaction[], wallets: Set<string>, owners: Map<string, string>, query: SolanaQuery): SolanaBatch {
  const blocks = new Map<number, SolanaBlock>();
  const transactions: SolanaTransaction[] = [];
  const balances: SolanaBalance[] = [];
  for (const raw of raws) {
    const keys = accountKeys(raw);
    const tx: SolanaTransaction = { signature: raw.transaction.signatures[0]!, slot: raw.slot, transactionIndex: raw.transactionIndex!, feePayer: keys[0]!, fee: BigInt(raw.meta.fee), success: raw.meta.err === null };
    transactions.push(tx);
    blocks.set(raw.slot, { slot: raw.slot, time: raw.blockTime ?? 0 });
    const pre = new Map((raw.meta.preTokenBalances ?? []).map((t) => [t.accountIndex, t]));
    const post = new Map((raw.meta.postTokenBalances ?? []).map((t) => [t.accountIndex, t]));
    keys.forEach((account, i) => {
      const token = post.get(i) ?? pre.get(i);
      const owner = token?.owner ?? owners.get(account) ?? "";
      const tokens = token && { mint: token.mint, owner, decimals: token.uiTokenAmount.decimals, pre: BigInt(pre.get(i)?.uiTokenAmount.amount ?? 0), post: BigInt(post.get(i)?.uiTokenAmount.amount ?? 0) };
      const row = solanaBalance({ signature: tx.signature, slot: tx.slot, transactionIndex: tx.transactionIndex, account }, BigInt(raw.meta.preBalances[i]!), BigInt(raw.meta.postBalances[i]!), tokens);
      if (wallets.has(walletOf(row))) balances.push(row);
    });
  }
  return { fromBlock: query.fromBlock, nextBlock: query.toBlock, blocks: [...blocks.values()], transactions, balances, instructions: [], logs: [], joinedBalances: [] };
}
