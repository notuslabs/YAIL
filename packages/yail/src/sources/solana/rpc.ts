import type { FetchOptions, SolanaBalance, SolanaBatch, SolanaBlock, SolanaQuery, SolanaSource, SolanaTransaction } from "../types.js";
import { mapLimit, request } from "../../util.js";
import { finishBatch, solanaBalance, walletOf } from "./shared.js";

export interface SolanaRpcOptions {
  kind: "solana";
  /** Solana JSON-RPC URL. The public https://api.mainnet-beta.solana.com throttles `getTransaction` hard (~0.5/s). */
  url: string;
  /** Parallel RPC calls. Default 4. */
  concurrency?: number;
  headers?: Record<string, string>;
  /** Override fetch (testing). */
  fetch?: typeof fetch;
}

/** Programs whose accounts hold tokens: SPL Token and Token-2022. */
export const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

interface RawTransaction {
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

/**
 * Solana source over plain JSON-RPC, address by address: `getSignaturesForAddress` for each wallet and each token
 * account it owns, then `getTransaction` for each signature. Cost grows with the wallets' transactions, not with
 * the slot range, so it suits old history of a few wallets: put it after `hypersync({ kind: "solana" })` in `union()`.
 *
 * Transfers into a token account do not name its wallet, so the token accounts' own signatures are read too. Open
 * ones come from `getTokenAccountsByOwner`. A closed one shows up in the transaction that closed it, which needs the
 * owner's signature: the wallet's transactions from the range's start up to the head name every account that existed
 * in the range. Those past the range are read only for that, and remembered.
 */
export function solanaRpc(options: SolanaRpcOptions): SolanaSource {
  const doFetch = options.fetch ?? fetch;
  const concurrency = options.concurrency ?? 4;
  let id = 0;
  /** Token accounts (account, owner) seen in each transaction read so far, for closed-account discovery. */
  const tokenAccountsIn = new Map<string, Array<[string, string]>>();

  async function call<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
    const init = { method: "POST", headers: { "Content-Type": "application/json", ...options.headers }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal };
    const text = await request(doFetch, options.url, init);
    // Lamports can pass 2^53: keep such numbers exact.
    const res = JSON.parse(text, (_key, value, context?: { source?: string }) => {
      if (typeof value === "number" && !Number.isSafeInteger(value) && context?.source && /^\d+$/.test(context.source)) return BigInt(context.source);
      return value;
    }) as { result?: T; error?: { code: number; message: string } };
    if (res.error) throw new Error(`rpc(${new URL(options.url).host}) ${method}: ${res.error.code} ${res.error.message}`);
    return res.result as T;
  }

  /** Signatures mentioning `account` in [from, to), newest first in pages of 1000. */
  async function signatures(account: string, from: number, to: number, signal?: AbortSignal): Promise<Array<{ signature: string; slot: number }>> {
    const out: Array<{ signature: string; slot: number }> = [];
    let before: string | undefined;
    for (;;) {
      const page = await call<Array<{ signature: string; slot: number }>>("getSignaturesForAddress", [account, { limit: 1000, before, commitment: "confirmed" }], signal);
      for (const s of page) if (s.slot >= from && s.slot < to) out.push({ signature: s.signature, slot: s.slot });
      if (page.length < 1000 || page.at(-1)!.slot < from) return out;
      before = page.at(-1)!.signature;
    }
  }

  async function getTransaction(signature: string, signal?: AbortSignal): Promise<RawTransaction> {
    const raw = await call<RawTransaction>("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }], signal);
    const keys = accountKeys(raw);
    tokenAccountsIn.set(signature, [...(raw.meta.preTokenBalances ?? []), ...(raw.meta.postTokenBalances ?? [])].filter((t) => t.owner).map((t) => [keys[t.accountIndex]!, t.owner!]));
    return raw;
  }

  /** Fill `transactionIndex` where the provider left it out: one `getBlock` (signatures only) per such slot. */
  async function orderInSlots(raws: RawTransaction[], signal?: AbortSignal): Promise<void> {
    const slots = [...new Set(raws.filter((r) => r.transactionIndex === undefined).map((r) => r.slot))];
    const blocks = await mapLimit(slots, concurrency, (slot) =>
      call<{ signatures: string[] }>("getBlock", [slot, { transactionDetails: "signatures", rewards: false, maxSupportedTransactionVersion: 1, commitment: "confirmed" }], signal),
    );
    const index = new Map(blocks.flatMap((b) => b.signatures.map((sig, i) => [sig, i] as const)));
    for (const raw of raws) raw.transactionIndex ??= index.get(raw.transaction.signatures[0]!);
  }

  async function tokenAccounts(owner: string, signal?: AbortSignal): Promise<string[]> {
    const lists = await Promise.all(
      TOKEN_PROGRAMS.map((programId) =>
        call<{ value: Array<{ pubkey: string }> }>("getTokenAccountsByOwner", [owner, { programId }, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" }], signal),
      ),
    );
    return lists.flatMap((l) => l.value.map((a) => a.pubkey));
  }

  return {
    kind: "solana",
    name: `rpc(${new URL(options.url).host})`,
    async getHeight() {
      return call<number>("getSlot", [{ commitment: "confirmed" }]);
    },
    async *fetch(query: SolanaQuery, fetchOptions?: FetchOptions) {
      const signal = fetchOptions?.signal;
      const wallets = new Set(query.addresses);
      const inRange = (slot: number) => slot >= query.fromBlock && slot < query.toBlock;
      const txs = new Map<string, RawTransaction>();
      /** Token account -> owning wallet. */
      const owners = new Map<string, string>();
      for (const [wallet, accounts] of await mapLimit([...wallets], concurrency, async (w) => [w, await tokenAccounts(w, signal)] as const)) {
        for (const a of accounts) owners.set(a, wallet);
      }
      const own = unique((await mapLimit([...wallets], concurrency, (w) => signatures(w, query.fromBlock, Infinity, signal))).flat());
      await mapLimit(own, concurrency, async ({ signature, slot }) => {
        if (!inRange(slot) && tokenAccountsIn.has(signature)) return;
        const raw = await getTransaction(signature, signal);
        if (inRange(slot)) txs.set(signature, raw);
      });
      for (const { signature } of own) {
        for (const [account, owner] of tokenAccountsIn.get(signature) ?? []) if (wallets.has(owner)) owners.set(account, owner);
      }
      const received = unique((await mapLimit([...owners.keys()], concurrency, (a) => signatures(a, query.fromBlock, query.toBlock, signal))).flat());
      const fresh = received.filter((s) => !txs.has(s.signature));
      for (const raw of await mapLimit(fresh, concurrency, (s) => getTransaction(s.signature, signal))) txs.set(raw.transaction.signatures[0]!, raw);
      await orderInSlots([...txs.values()], signal);
      yield finishBatch(toBatch([...txs.values()], wallets, owners, query));
    },
  };
}

function unique(list: Array<{ signature: string; slot: number }>): Array<{ signature: string; slot: number }> {
  return [...new Map(list.map((s) => [s.signature, s])).values()];
}

function accountKeys(raw: RawTransaction): string[] {
  const loaded = raw.meta.loadedAddresses;
  return [...raw.transaction.message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
}

function toBatch(raws: RawTransaction[], wallets: Set<string>, owners: Map<string, string>, query: SolanaQuery): SolanaBatch {
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
  return { fromBlock: query.fromBlock, nextBlock: query.toBlock, blocks: [...blocks.values()], transactions, balances };
}
