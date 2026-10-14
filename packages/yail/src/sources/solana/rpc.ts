import type { FetchOptions, SolanaQuery, SolanaSource } from "../types.js";
import { mapLimit } from "../../util.js";
import { jsonRpc, orderInSlots, tokenOwners, toBatch, type RawTransaction } from "./json-rpc.js";
import { finishBatch } from "./shared.js";

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

/**
 * Solana source over plain JSON-RPC, address by address: `getSignaturesForAddress` for each wallet and each token
 * account it owns, then `getTransaction` for each signature. Cost grows with the wallets' transactions, not with
 * the slot range, so it suits old history of a few wallets: put it after `hypersync({ kind: "solana" })` in `union()`.
 *
 * Transfers into a token account do not name its wallet, so the token accounts' own signatures are read too. Open
 * ones come from `getTokenAccountsByOwner`. A closed one shows up in the transaction that closed it, which needs the
 * owner's signature: the wallet's transactions from the range's start up to the head name every account that existed
 * in the range. Those past the range are read only for that, and remembered.
 *
 * Program instructions and log lines are not served: a query for them throws, so a program that starts below
 * HyperSync's first slot fails loudly instead of indexing nothing.
 */
export function solanaRpc(options: SolanaRpcOptions): SolanaSource {
  const call = jsonRpc(`rpc(${new URL(options.url).host})`, options);
  const concurrency = options.concurrency ?? 4;
  /** Token accounts (account, owner) seen in each transaction read so far, for closed-account discovery. */
  const tokenAccountsIn = new Map<string, Array<[string, string]>>();

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
    tokenAccountsIn.set(signature, tokenOwners(raw));
    return raw;
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
      if (query.instructions?.length || query.logs?.length) {
        throw new Error(`rpc({ kind: "solana" }): program instructions and logs need hypersync({ kind: "solana" }); start the program at or above its first slot (slots ${query.fromBlock}-${query.toBlock - 1} were asked)`);
      }
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
      await orderInSlots([...txs.values()], call, concurrency, signal);
      yield finishBatch(toBatch([...txs.values()], wallets, owners, query));
    },
  };
}

function unique(list: Array<{ signature: string; slot: number }>): Array<{ signature: string; slot: number }> {
  return [...new Map(list.map((s) => [s.signature, s])).values()];
}
