import type { FetchOptions, SolanaBalance, SolanaBatch, SolanaBlock, SolanaQuery, SolanaSource, SolanaTransaction } from "./types.js";
import { chunkList } from "../util.js";

export interface HypersyncSolanaOptions {
  /** Default https://solana.hypersync.xyz. */
  url?: string;
  /** Envio API token (https://app.envio.dev/api-tokens). Falls back to ENVIO_API_TOKEN. */
  apiToken?: string;
  /**
   * Slot windows fetched in parallel over long ranges. Default 16. The server, not the token's rate limit, bounds
   * throughput (2026-10: one stream ≈ 6k slots/s, 32 ≈ 16k).
   */
  concurrency?: number;
  /** Slots per parallel window. Default 250_000. */
  windowSlots?: number;
  /** Override fetch (testing). */
  fetch?: typeof fetch;
}

const BLOCK_FIELDS = ["slot", "block_time", "blockhash", "parent_blockhash"];
const TX_FIELDS = ["slot", "transaction_index", "transaction_id", "fee_payer", "success", "fee"];
const ACTIVITY_FIELDS = ["slot", "transaction_index", "transaction_id", "account", "pre_balance", "post_balance", "mint", "pre_owner", "post_owner", "token_decimals", "pre_token_balance", "post_token_balance"];
/** Lamport amounts can pass 2^53: read them from the JSON text, not as doubles. */
const BIG_FIELDS = new Set(["pre_balance", "post_balance", "fee"]);
/** The system program never pays fees: a selection that matches nothing, for probing which slots are held. */
const NOTHING = { transactions: [{ fee_payer: ["11111111111111111111111111111111"] }], field_selection: { transaction: ["slot"] } };

interface QueryResponse {
  next_slot: number;
  blocks?: Array<Array<{ slot: number; block_time: number; blockhash?: string; parent_blockhash?: string }>>;
  transactions?: Array<Array<{ slot: number; transaction_index: number; transaction_id: string; fee_payer: string; success: boolean; fee: bigint }>>;
  account_activity?: Array<Array<ActivityRow>>;
}

interface ActivityRow {
  slot: number;
  transaction_index: number;
  transaction_id: string;
  account: string;
  pre_balance?: bigint;
  post_balance?: bigint;
  mint?: string;
  pre_owner?: string;
  post_owner?: string;
  token_decimals?: number;
  pre_token_balance?: string;
  post_token_balance?: string;
}

/**
 * Solana source backed by Envio's Solana HyperSync (https://docs.envio.dev/docs/HyperSync/solana). Each query
 * reads the `account_activity` of the wallets: rows of their own account plus rows of every token account they
 * own. HyperSync keeps only recent slots (from ~2026-01 as of 2026-10): pair it with `solanaRpc()` in `union()`
 * for older history. `firstBlock()` reports where its history starts.
 */
export function hypersyncSolana(options: HypersyncSolanaOptions = {}): SolanaSource {
  const base = (options.url ?? "https://solana.hypersync.xyz").replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  const concurrency = options.concurrency ?? 16;
  const windowSlots = options.windowSlots ?? 250_000;
  let floor: number | undefined;

  async function post(body: unknown, signal?: AbortSignal): Promise<QueryResponse> {
    // Resolved lazily so `yail ddl` / `yail migrate` work without a token.
    const apiToken = options.apiToken ?? process.env.ENVIO_API_TOKEN;
    if (!apiToken) throw new Error(`hypersyncSolana(${base}): missing apiToken. Pass it explicitly or set ENVIO_API_TOKEN (https://app.envio.dev/api-tokens).`);
    const text = await request(doFetch, `${base}/query`, { method: "POST", headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    return JSON.parse(text, (key, value, context?: { source?: string }) => {
      if (BIG_FIELDS.has(key) && typeof value === "number") return BigInt(context?.source ?? value);
      return value;
    }) as QueryResponse;
  }

  const getHeight = async () => Number(await request(doFetch, `${base}/height`, {}));

  /** Does the server hold `slot`? Below its history it answers without advancing. */
  async function holds(slot: number): Promise<boolean> {
    const res = await post({ from_slot: slot, to_slot: slot + 1, ...NOTHING });
    return res.next_slot > slot;
  }

  /** Every page of one window, as one batch. */
  async function readWindow(query: SolanaQuery, from: number, to: number, signal?: AbortSignal): Promise<SolanaBatch> {
    const batch: SolanaBatch = { fromBlock: from, nextBlock: to, blocks: [], transactions: [], balances: [] };
    const selections = chunkList(query.addresses, 500).flatMap((chunk) => [{ account: chunk }, { owner: chunk }]);
    let slot = from;
    for (let stalls = 0; slot < to; ) {
      signal?.throwIfAborted();
      const res = await post({ from_slot: slot, to_slot: to, account_activity: selections, field_selection: { block: BLOCK_FIELDS, transaction: TX_FIELDS, account_activity: ACTIVITY_FIELDS } }, signal);
      if (res.next_slot <= slot) {
        // Near the head the server can trail its reported height: ask again before giving up.
        if (++stalls === 5) throw new Error(`hypersyncSolana: next_slot ${res.next_slot} did not advance from ${slot} (below its history, which starts at ${floor ?? "?"}, or behind the head)`);
        await sleep(1000 * stalls, signal);
        continue;
      }
      stalls = 0;
      for (const b of res.blocks?.flat() ?? []) batch.blocks.push({ slot: b.slot, time: b.block_time, hash: b.blockhash, parentHash: b.parent_blockhash });
      for (const t of res.transactions?.flat() ?? []) {
        batch.transactions.push({ signature: t.transaction_id, slot: t.slot, transactionIndex: t.transaction_index, feePayer: t.fee_payer, fee: t.fee, success: t.success });
      }
      for (const r of res.account_activity?.flat() ?? []) batch.balances.push(toBalance(r));
      slot = Math.min(res.next_slot, to);
    }
    return batch;
  }

  return {
    kind: "solana",
    name: `hypersyncSolana(${new URL(base).host})`,
    getHeight,
    async firstBlock() {
      // The floor only moves down: one probe tells whether it did.
      if (floor === 0 || (floor !== undefined && !(await holds(floor - 1)))) return floor;
      let lo = 0;
      let hi = floor ?? (await getHeight());
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (await holds(mid)) hi = mid;
        else lo = mid + 1;
      }
      floor = lo;
      return floor;
    },
    async *fetch(query: SolanaQuery, fetchOptions?: FetchOptions) {
      if (query.addresses.length === 0) {
        yield { fromBlock: query.fromBlock, nextBlock: query.toBlock, blocks: [], transactions: [], balances: [] } satisfies SolanaBatch;
        return;
      }
      // Windows run `concurrency` at a time and come out in order.
      const pending: Array<Promise<SolanaBatch>> = [];
      let next = query.fromBlock;
      const fill = () => {
        while (pending.length < concurrency && next < query.toBlock) {
          const to = Math.min(next + windowSlots, query.toBlock);
          const window = readWindow(query, next, to, fetchOptions?.signal);
          window.catch(() => {}); // awaited below, in order
          pending.push(window);
          next = to;
        }
      };
      fill();
      while (pending.length > 0) {
        const batch = await pending.shift()!;
        fill();
        yield finishBatch(batch);
      }
    },
  };
}

function toBalance(r: ActivityRow): SolanaBalance {
  // HyperSync carries the SOL side only when it changed.
  return solanaBalance(
    { signature: r.transaction_id, slot: r.slot, transactionIndex: r.transaction_index, account: r.account },
    r.pre_balance ?? 0n,
    r.post_balance ?? 0n,
    r.mint ? { mint: r.mint, owner: r.post_owner ?? r.pre_owner ?? "", decimals: r.token_decimals ?? 0, pre: BigInt(r.pre_token_balance ?? 0), post: BigInt(r.post_token_balance ?? 0) } : undefined,
  );
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
