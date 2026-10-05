import type { FetchOptions, SolanaBalance, SolanaBatch, SolanaBlock, SolanaQuery, SolanaSource, SolanaTransaction } from "./types.js";
import { finishBatch, request, solanaBalance } from "./hypersync-solana.js";

export interface SolanaRpcOptions {
  /** Solana JSON-RPC URL. The public https://api.mainnet-beta.solana.com throttles `getTransaction` hard (~0.5/s). */
  url: string;
  /** Parallel RPC calls. Default 4. */
  concurrency?: number;
  headers?: Record<string, string>;
  /** Override fetch (testing). */
  fetch?: typeof fetch;
}

const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

interface RawTransaction {
  slot: number;
  blockTime: number | null;
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
 * the slot range, so it suits old history of a few wallets: put it after `hypersyncSolana()` in `union()`.
 *
 * Token accounts come from `getTokenAccountsByOwner` (the open ones) and from the wallets' own transactions (closed
 * ones show up where the wallet created or closed them). Transfers into a token account need it: they do not name
 * the wallet, so the wallet's own signatures miss them.
 */
export function solanaRpc(options: SolanaRpcOptions): SolanaSource {
  const doFetch = options.fetch ?? fetch;
  const concurrency = options.concurrency ?? 4;
  let id = 0;

  async function call<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
    const init = { method: "POST", headers: { "Content-Type": "application/json", ...options.headers }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal };
    const text = await request(doFetch, options.url, init);
    // Lamports can pass 2^53: keep such numbers exact.
    const res = JSON.parse(text, (_key, value, context?: { source?: string }) => {
      if (typeof value === "number" && !Number.isSafeInteger(value) && context?.source && /^\d+$/.test(context.source)) return BigInt(context.source);
      return value;
    }) as { result?: T; error?: { code: number; message: string } };
    if (res.error) throw new Error(`solanaRpc ${method}: ${res.error.code} ${res.error.message}`);
    return res.result as T;
  }

  /** Signatures mentioning `account` in [from, to), newest first in pages of 1000. */
  async function signatures(account: string, from: number, to: number, signal?: AbortSignal): Promise<string[]> {
    const out: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await call<Array<{ signature: string; slot: number }>>("getSignaturesForAddress", [account, { limit: 1000, before, commitment: "confirmed" }], signal);
      for (const s of page) if (s.slot >= from && s.slot < to) out.push(s.signature);
      if (page.length < 1000 || page.at(-1)!.slot < from) return out;
      before = page.at(-1)!.signature;
    }
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
    name: `solanaRpc(${new URL(options.url).host})`,
    async getHeight() {
      return call<number>("getSlot", [{ commitment: "confirmed" }]);
    },
    async *fetch(query: SolanaQuery, fetchOptions?: FetchOptions) {
      const signal = fetchOptions?.signal;
      const wallets = new Set(query.addresses);
      /** Token account -> owning wallet. */
      const owners = new Map<string, string>();
      for (const [wallet, accounts] of await mapLimit([...wallets], concurrency, async (w) => [w, await tokenAccounts(w, signal)] as const)) {
        for (const a of accounts) owners.set(a, wallet);
      }
      const txs = new Map<string, RawTransaction>();
      let accounts = [...wallets, ...owners.keys()];
      while (accounts.length > 0) {
        const found = (await mapLimit(accounts, concurrency, (a) => signatures(a, query.fromBlock, query.toBlock, signal))).flat();
        const fresh = [...new Set(found)].filter((s) => !txs.has(s));
        const raws = await mapLimit(fresh, concurrency, (s) => call<RawTransaction>("getTransaction", [s, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }], signal));
        // Token accounts the wallets owned in these transactions but no longer hold (closed) were not listed yet.
        accounts = [];
        for (const raw of raws) {
          txs.set(raw.transaction.signatures[0]!, raw);
          for (const t of [...(raw.meta.preTokenBalances ?? []), ...(raw.meta.postTokenBalances ?? [])]) {
            const account = accountKeys(raw)[t.accountIndex]!;
            if (!t.owner || !wallets.has(t.owner) || owners.has(account)) continue;
            owners.set(account, t.owner);
            accounts.push(account);
          }
        }
      }
      yield finishBatch(toBatch([...txs.values()], wallets, owners, query));
    },
  };
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
    const tx: SolanaTransaction = { signature: raw.transaction.signatures[0]!, slot: raw.slot, transactionIndex: raw.transactionIndex ?? 0, feePayer: keys[0]!, fee: BigInt(raw.meta.fee), success: raw.meta.err === null };
    transactions.push(tx);
    blocks.set(raw.slot, { slot: raw.slot, time: raw.blockTime ?? 0 });
    const pre = new Map((raw.meta.preTokenBalances ?? []).map((t) => [t.accountIndex, t]));
    const post = new Map((raw.meta.postTokenBalances ?? []).map((t) => [t.accountIndex, t]));
    keys.forEach((account, i) => {
      const token = post.get(i) ?? pre.get(i);
      const owner = token?.owner ?? owners.get(account) ?? "";
      if (!wallets.has(account) && !(token && wallets.has(owner))) return;
      const tokens = token && { mint: token.mint, owner, decimals: token.uiTokenAmount.decimals, pre: BigInt(pre.get(i)?.uiTokenAmount.amount ?? 0), post: BigInt(post.get(i)?.uiTokenAmount.amount ?? 0) };
      balances.push(solanaBalance({ signature: tx.signature, slot: tx.slot, transactionIndex: tx.transactionIndex, account }, BigInt(raw.meta.preBalances[i]!), BigInt(raw.meta.postBalances[i]!), tokens));
    });
  }
  return { fromBlock: query.fromBlock, nextBlock: query.toBlock, blocks: [...blocks.values()], transactions, balances };
}

/** `fn` over `items`, at most `limit` at a time, results in input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}
