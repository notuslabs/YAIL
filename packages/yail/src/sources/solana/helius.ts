import type { FetchOptions, SolanaQuery, SolanaSource } from "../types.js";
import { counted, mapLimit, requestListeners } from "../../util.js";
import { jsonRpc, orderInSlots, toBatch, type RawTransaction } from "./json-rpc.js";
import { solanaRpc } from "./rpc.js";
import { finishBatch } from "./shared.js";

export interface HeliusOptions {
  /** Helius RPC URL with its key, e.g. https://mainnet.helius-rpc.com/?api-key=… */
  url: string;
  /** Parallel calls. Default 4. */
  concurrency?: number;
  headers?: Record<string, string>;
  /** Override fetch (testing). */
  fetch?: typeof fetch;
}

/** First slot whose token balances name their owner (Dec 2022): Helius finds a wallet's token accounts from there on. */
const TOKEN_OWNERS_FROM_SLOT = 111_491_819;

/**
 * Solana wallets through Helius's `getTransactionsForAddress`, a Helius-only method: each wallet's transactions, those
 * of the token accounts it owns included, oldest first, 1,000 full transactions per call. From slot 111,491,819 on,
 * the same batches as `rpc({ kind: "solana" })` without its `getTransaction` per transaction.
 *
 * Helius tells a wallet's token accounts from the owner in their token balances, which Solana records from slot
 * 111,491,819 (December 2022) on. For a range starting below it, each wallet is first asked for one signature of its
 * own below that slot. The wallets that have one are read there like `rpc({ kind: "solana" })` does, on the same URL
 * and at its cost: one `getTransaction` per transaction of the wallet from the range's start up to the head. The
 * others get no rows below that slot: a token account someone else opened for such a wallet, or handed to it, without
 * naming it (`InitializeAccount2`/`3`, `SetAuthority`) loses its rows from before December 2022.
 *
 * `tokenAccounts: "all"` returns the transactions that change only a token account's lamports too, which
 * `"balanceChanged"` may leave out. Program instructions and log lines are not served: a query for them throws.
 */
export function helius(options: HeliusOptions): SolanaSource {
  const name = `helius(${new URL(options.url).host})`;
  const listeners = requestListeners();
  const doFetch = counted(options.fetch ?? fetch, listeners.count);
  const call = jsonRpc(name, { ...options, fetch: doFetch });
  const concurrency = options.concurrency ?? 4;
  const beforeTokenOwners = solanaRpc({ ...options, kind: "solana", fetch: doFetch });

  async function history(wallet: string, from: number, to: number, signal?: AbortSignal): Promise<RawTransaction[]> {
    const transactions: RawTransaction[] = [];
    let paginationToken: string | undefined;
    for (;;) {
      const page = await call<{ data: RawTransaction[]; paginationToken: string | null }>("getTransactionsForAddress", [wallet, { transactionDetails: "full", sortOrder: "asc", limit: 1000, paginationToken, encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed", filters: { slot: { gte: from, lt: to }, tokenAccounts: "all" } }], signal);
      transactions.push(...page.data);
      if (page.paginationToken === null) return transactions;
      paginationToken = page.paginationToken;
    }
  }

  /** The wallets with a transaction of their own in [from, to): one signature asked of each. */
  async function withHistory(wallets: string[], from: number, to: number, signal?: AbortSignal): Promise<string[]> {
    const pages = await mapLimit(wallets, concurrency, async (wallet) => ({
      wallet,
      page: await call<{ data: unknown[] }>("getTransactionsForAddress", [wallet, { transactionDetails: "signatures", limit: 1, commitment: "confirmed", filters: { slot: { gte: from, lt: to } } }], signal),
    }));
    return pages.filter(({ page }) => page.data.length > 0).map(({ wallet }) => wallet);
  }

  return {
    kind: "solana",
    name,
    async getHeight() {
      return call<number>("getSlot", [{ commitment: "confirmed" }]);
    },
    async *fetch(query: SolanaQuery, fetchOptions?: FetchOptions) {
      if (query.instructions?.length || query.logs?.length) {
        throw new Error(`helius(): program instructions and logs need hypersync({ kind: "solana" }); start the program at or above its first slot (slots ${query.fromBlock}-${query.toBlock - 1} were asked)`);
      }
      const signal = fetchOptions?.signal;
      const wallets = new Set(query.addresses);
      const from = Math.min(Math.max(query.fromBlock, TOKEN_OWNERS_FROM_SLOT), query.toBlock);
      const walletsWithOldHistory = query.fromBlock < from ? await withHistory([...wallets], query.fromBlock, from, signal) : [];
      if (walletsWithOldHistory.length > 0) yield* beforeTokenOwners.fetch({ ...query, addresses: walletsWithOldHistory, toBlock: from }, fetchOptions);
      const fromBlock = walletsWithOldHistory.length > 0 ? from : query.fromBlock;
      if (fromBlock === query.toBlock) return;
      const histories = from < query.toBlock ? await mapLimit([...wallets], concurrency, (w) => history(w, from, query.toBlock, signal)) : [];
      const raws = [...new Map(histories.flat().map((raw) => [raw.transaction.signatures[0]!, raw])).values()];
      await orderInSlots(raws, call, concurrency, signal);
      yield finishBatch(toBatch(raws, wallets, new Map(), { ...query, fromBlock }));
    },
    onRequest: listeners.onRequest,
  };
}
