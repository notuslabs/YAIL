import type { FetchOptions, SolanaQuery, SolanaSource } from "../types.js";
import { mapLimit } from "../../util.js";
import { jsonRpc, orderInSlots, tokenOwners, toBatch, type RawTransaction } from "./json-rpc.js";
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

interface HistoryPage {
  data: RawTransaction[];
  paginationToken: string | null;
}

/**
 * Solana wallets through Helius's `getTransactionsForAddress`, a Helius-only method: each wallet's transactions, those
 * of the token accounts it owns included, oldest first, 1,000 full transactions per call. Same batches as
 * `rpc({ kind: "solana" })` without its `getTransaction` per transaction.
 *
 * Helius tells a wallet's token accounts from the owner in their token balances, which Solana records from slot
 * 111,491,819 on: lower slots are read like `rpc({ kind: "solana" })` does, on the same URL. `tokenAccounts: "all"`
 * returns the transactions that change only a token account's lamports too, which `"balanceChanged"` may leave out.
 *
 * Program instructions and log lines are not served: a query for them throws.
 */
export function helius(options: HeliusOptions): SolanaSource {
  const name = `helius(${new URL(options.url).host})`;
  const call = jsonRpc(name, options);
  const concurrency = options.concurrency ?? 4;
  const beforeTokenOwners = solanaRpc({ ...options, kind: "solana" });

  async function history(wallet: string, from: number, to: number, signal?: AbortSignal): Promise<RawTransaction[]> {
    const transactions: RawTransaction[] = [];
    let paginationToken: string | undefined;
    do {
      const config = { transactionDetails: "full", sortOrder: "asc", limit: 1000, paginationToken, encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed", filters: { slot: { gte: from, lt: to }, tokenAccounts: "all" } };
      const page = await call<HistoryPage>("getTransactionsForAddress", [wallet, config], signal);
      transactions.push(...page.data);
      paginationToken = page.paginationToken ?? undefined;
    } while (paginationToken);
    return transactions;
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
      const from = Math.min(Math.max(query.fromBlock, TOKEN_OWNERS_FROM_SLOT), query.toBlock);
      if (query.fromBlock < from) yield* beforeTokenOwners.fetch({ ...query, toBlock: from }, fetchOptions);
      if (from === query.toBlock) return;
      const signal = fetchOptions?.signal;
      const wallets = new Set(query.addresses);
      const histories = await mapLimit([...wallets], concurrency, (w) => history(w, from, query.toBlock, signal));
      const txs = new Map(histories.flat().map((raw) => [raw.transaction.signatures[0]!, raw]));
      const owners = new Map<string, string>();
      for (const raw of txs.values()) {
        for (const [account, owner] of tokenOwners(raw)) if (wallets.has(owner)) owners.set(account, owner);
      }
      await orderInSlots([...txs.values()], call, concurrency, signal);
      yield finishBatch(toBatch([...txs.values()], wallets, owners, { ...query, fromBlock: from }));
    },
  };
}
