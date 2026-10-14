import type { FetchOptions, SolanaBalance, SolanaBatch, SolanaBlock, SolanaInstruction, SolanaInstructionFilter, SolanaLog, SolanaQuery, SolanaSource, SolanaTransaction } from "../types.js";
import { chunkList, request, sleep } from "../../util.js";
import { finishBatch, solanaBalance } from "./shared.js";

export interface SolanaHypersyncOptions {
  kind: "solana";
  /** Default https://solana.hypersync.xyz. */
  url?: string;
  /** Envio API token (https://app.envio.dev/api-tokens). Falls back to ENVIO_API_TOKEN. */
  apiToken?: string;
  /**
   * Slot windows fetched in parallel over long ranges. Default 16. The server, not the token's rate limit, bounds
   * throughput (2026-10: one stream ≈ 6k slots/s, 32 ≈ 16k).
   */
  concurrency?: number;
  /**
   * Slots per parallel window, each held in memory as one batch. Default 250_000, or 10_000 when the query selects
   * program instructions or logs (a busy program writes thousands of rows per window where a wallet writes a few).
   */
  windowSlots?: number;
  /** Override fetch (testing). */
  fetch?: typeof fetch;
}

const BLOCK_FIELDS = ["slot", "block_time", "blockhash", "parent_blockhash"];
const TX_FIELDS = ["slot", "transaction_index", "transaction_id", "fee_payer", "success", "fee"];
const ACTIVITY_FIELDS = ["slot", "transaction_index", "transaction_id", "account", "pre_balance", "post_balance", "mint", "pre_owner", "post_owner", "token_decimals", "pre_token_balance", "post_token_balance"];
const INSTRUCTION_FIELDS = ["slot", "transaction_index", "instruction_address", "executing_account", "account_arguments", "data"];
const LOG_FIELDS = ["slot", "transaction_index", "instruction_address", "program_id", "kind", "message"];
/** Lamport amounts can pass 2^53: read them from the JSON text, not as doubles. */
const BIG_FIELDS = new Set(["pre_balance", "post_balance", "fee"]);
/** The system program never pays fees: a selection that matches nothing, for probing which slots are held. */
const NOTHING = { transactions: [{ fee_payer: ["11111111111111111111111111111111"] }], field_selection: { transaction: ["slot"] } };

interface QueryResponse {
  next_slot: number;
  blocks?: Array<Array<{ slot: number; block_time: number; blockhash?: string; parent_blockhash?: string }>>;
  transactions?: Array<Array<{ slot: number; transaction_index: number; transaction_id: string; fee_payer: string; success: boolean; fee: bigint }>>;
  account_activity?: Array<Array<ActivityRow>>;
  instruction_calls?: Array<Array<InstructionRow>>;
  logs?: Array<Array<LogRow>>;
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

interface InstructionRow {
  slot: number;
  transaction_index: number;
  instruction_address: number[];
  executing_account: string;
  account_arguments?: string[];
  data?: string;
}

interface LogRow {
  slot: number;
  transaction_index: number;
  instruction_address?: number[] | null;
  program_id: string;
  kind: string;
  message?: string;
}

/** One request of a window, paginated on its own: its selections and the tables it reads. */
interface WindowRequest {
  kind: "wallets" | "programs";
  selections: Record<string, unknown>;
  fields: Record<string, string[]>;
}

/**
 * Solana source backed by Envio's Solana HyperSync (https://docs.envio.dev/docs/HyperSync/solana). Each query
 * reads the `account_activity` of the wallets (rows of their own account plus rows of every token account they
 * own) and the instructions and log lines of the programs. HyperSync keeps only recent slots (from ~2026-01 as of
 * 2026-10): pair it with `rpc({ kind: "solana", url })` in `union()` for older wallet history. `firstBlock()`
 * reports where its history starts.
 */
export function solanaHypersync(options: SolanaHypersyncOptions): SolanaSource {
  const base = (options.url ?? "https://solana.hypersync.xyz").replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  const concurrency = options.concurrency ?? 16;
  let floor: number | undefined;

  async function post(body: unknown, signal?: AbortSignal): Promise<QueryResponse> {
    // Resolved lazily so `yail ddl` / `yail migrate` work without a token.
    const apiToken = options.apiToken ?? process.env.ENVIO_API_TOKEN;
    if (!apiToken) throw new Error(`hypersync(${base}): missing apiToken. Pass it explicitly or set ENVIO_API_TOKEN (https://app.envio.dev/api-tokens).`);
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

  /** Every page of one request over [from, to). */
  async function* pages(req: WindowRequest, from: number, to: number, signal?: AbortSignal): AsyncGenerator<QueryResponse> {
    let slot = from;
    for (let stalls = 0; slot < to; ) {
      signal?.throwIfAborted();
      const res = await post({ from_slot: slot, to_slot: to, ...req.selections, field_selection: { block: BLOCK_FIELDS, transaction: TX_FIELDS, ...req.fields } }, signal);
      if (res.next_slot <= slot) {
        // Near the head the server can trail its reported height: ask again before giving up.
        if (++stalls === 5) throw new Error(`hypersync(${base}): next_slot ${res.next_slot} did not advance from ${slot} (below its history, which starts at ${floor ?? "?"}, or behind the head)`);
        await sleep(1000 * stalls, signal);
        continue;
      }
      stalls = 0;
      yield res;
      slot = Math.min(res.next_slot, to);
    }
  }

  /**
   * Every request of one window, as one batch. A transaction comes back from each request that matches it: its rows
   * are kept once. Log lines are kept per (transaction, program, kind) from the first request that returned any, since
   * a request returns all of them or none, in the order they were written.
   */
  async function readWindow(requests: WindowRequest[], from: number, to: number, signal?: AbortSignal): Promise<SolanaBatch> {
    const blocks = new Map<number, SolanaBlock>();
    const transactions = new Map<string, SolanaTransaction>();
    const balances: SolanaBalance[] = [];
    const instructions = new Map<string, SolanaInstruction>();
    const logs: SolanaLog[] = [];
    const logGroups = new Set<string>();
    const joinedBalances = new Map<string, SolanaBalance>();
    const transactionOf = (row: { slot: number; transaction_index: number }): SolanaTransaction => {
      const tx = transactions.get(`${row.slot}:${row.transaction_index}`);
      if (!tx) throw new Error(`hypersync(${base}): a row of slot ${row.slot} came without its transaction (index ${row.transaction_index})`);
      return tx;
    };
    for (const req of requests) {
      const groups = new Set<string>();
      for await (const res of pages(req, from, to, signal)) {
        for (const b of res.blocks?.flat() ?? []) blocks.set(b.slot, { slot: b.slot, time: b.block_time, hash: b.blockhash, parentHash: b.parent_blockhash });
        for (const t of res.transactions?.flat() ?? []) {
          transactions.set(`${t.slot}:${t.transaction_index}`, { signature: t.transaction_id, slot: t.slot, transactionIndex: t.transaction_index, feePayer: t.fee_payer, fee: t.fee, success: t.success });
        }
        for (const r of res.account_activity?.flat() ?? []) {
          const row = toBalance(r);
          if (req.kind === "wallets") balances.push(row);
          else joinedBalances.set(`${row.signature}:${row.account}`, row);
        }
        for (const r of res.instruction_calls?.flat() ?? []) {
          const { signature } = transactionOf(r);
          const address = r.instruction_address;
          instructions.set(`${signature}:${address.join(".")}`, { signature, slot: r.slot, transactionIndex: r.transaction_index, address, program: r.executing_account, accounts: r.account_arguments ?? [], data: r.data ?? "", isInner: address.length > 1 });
        }
        for (const r of res.logs?.flat() ?? []) {
          if (r.kind !== "log" && r.kind !== "data") continue;
          const { signature } = transactionOf(r);
          const group = `${signature}:${r.program_id}:${r.kind}`;
          if (logGroups.has(group)) continue;
          groups.add(group);
          logs.push({ signature, slot: r.slot, transactionIndex: r.transaction_index, instructionAddress: r.instruction_address ?? null, program: r.program_id, kind: r.kind, message: r.message ?? "" });
        }
      }
      for (const group of groups) logGroups.add(group);
    }
    return { fromBlock: from, nextBlock: to, blocks: [...blocks.values()], transactions: [...transactions.values()], balances, instructions: [...instructions.values()], logs, joinedBalances: [...joinedBalances.values()] };
  }

  return {
    kind: "solana",
    name: `hypersync(${new URL(base).host})`,
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
      const requests = requestsOf(query);
      if (requests.length === 0) {
        yield { fromBlock: query.fromBlock, nextBlock: query.toBlock, blocks: [], transactions: [], balances: [], instructions: [], logs: [], joinedBalances: [] } satisfies SolanaBatch;
        return;
      }
      const windowSlots = options.windowSlots ?? (requests.some((r) => r.kind === "programs") ? 10_000 : 250_000);
      // Windows run `concurrency` at a time and come out in order.
      const pending: Array<Promise<SolanaBatch>> = [];
      let next = query.fromBlock;
      const fill = () => {
        while (pending.length < concurrency && next < query.toBlock) {
          const to = Math.min(next + windowSlots, query.toBlock);
          const window = readWindow(requests, next, to, fetchOptions?.signal);
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

/**
 * The requests a query needs. HyperSync intersects the selections of different tables per transaction, so wallets,
 * instructions and log lines go in separate requests, except an instruction filter with `logKinds`, whose request
 * carries both on purpose. Those come first: their log lines are complete for their programs and kinds.
 */
function requestsOf(query: SolanaQuery): WindowRequest[] {
  const instructions = query.instructions ?? [];
  const logs = query.logs ?? [];
  const requests = instructions
    .filter((f) => f.logKinds.length > 0)
    .map((f) => programRequest({ instruction_calls: instructionSelections(f), logs: [{ program_id: f.programs, kind: f.logKinds }] }, { instruction_call: INSTRUCTION_FIELDS, log: LOG_FIELDS }, f.balances));
  for (const balances of [false, true]) {
    const plain = instructions.filter((f) => f.logKinds.length === 0 && f.balances === balances);
    if (plain.length > 0) requests.push(programRequest({ instruction_calls: plain.flatMap(instructionSelections) }, { instruction_call: INSTRUCTION_FIELDS }, balances));
    const lines = logs.filter((f) => f.balances === balances);
    if (lines.length > 0) requests.push(programRequest({ logs: lines.map((f) => ({ program_id: f.programs, kind: f.kinds })) }, { log: LOG_FIELDS }, balances));
  }
  if (query.addresses.length > 0) {
    const selections = chunkList(query.addresses, 500).flatMap((chunk) => [{ account: chunk }, { owner: chunk }]);
    requests.push({ kind: "wallets", selections: { account_activity: selections }, fields: { account_activity: ACTIVITY_FIELDS } });
  }
  return requests;
}

function programRequest(selections: Record<string, unknown>, fields: Record<string, string[]>, balances: boolean): WindowRequest {
  return { kind: "programs", selections, fields: balances ? { ...fields, account_activity: ACTIVITY_FIELDS } : fields };
}

/** One selection per discriminator length: HyperSync matches data prefixes through `d1`, `d2`, `d4` and `d8`. */
function instructionSelections(f: SolanaInstructionFilter): Array<Record<string, unknown>> {
  const selection: Record<string, unknown> = { executing_account: f.programs, tx_success: true };
  if (f.isInner !== undefined) selection.is_inner = f.isInner;
  if (f.discriminators.length === 0) return [selection];
  const lengths = [...new Set(f.discriminators.map((d) => d.length / 2))];
  return lengths.map((bytes) => ({ ...selection, [`d${bytes}`]: f.discriminators.filter((d) => d.length / 2 === bytes) }));
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
