import { describe, expect, it } from "vitest";
import { helius } from "../src/sources/solana/helius.js";
import { rpc } from "../src/sources/rpc.js";
import { union } from "../src/sources/union.js";
import { hypersync } from "../src/sources/hypersync.js";
import type { SolanaBatch, SolanaQuery, SolanaSource } from "../src/sources/types.js";

const URL_WITH_KEY = "https://mainnet.helius-rpc.com/?api-key=test";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** Above slot 111,491,819, where token balances name their owner. */
const S = 300_000_000;

interface ChainTx {
  signature: string;
  slot: number;
  index: number;
  keys: string[];
  /** Writable addresses loaded from lookup tables (v0 transactions). */
  loaded?: string[];
  failed?: boolean;
  lamports?: Record<string, [bigint, bigint]>;
  tokens?: Record<string, { owner?: string; pre?: bigint; post?: bigint }>;
}

interface NodeOptions {
  /** Transactions per `getTransactionsForAddress` page, below the 1,000 asked for. */
  pageSize?: number;
  /** `getTransactionsForAddress` items carry `transactionIndex`. */
  withIndex?: boolean;
  /** Replaces the answer to a method. */
  override?: (method: string, params: any[]) => Response | undefined;
}

/** Big integers as JSON numbers, the way a node writes lamports. */
function json(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `#${v}#` : v)).replace(/"#(\d+)#"/g, "$1");
}

function allKeys(tx: ChainTx): string[] {
  return [...tx.keys, ...(tx.loaded ?? [])];
}

function raw(tx: ChainTx) {
  const keys = allKeys(tx);
  const tokenBalances = (side: "pre" | "post") =>
    Object.entries(tx.tokens ?? {}).flatMap(([account, t]) => {
      const amount = t[side];
      if (amount === undefined) return [];
      return [{ accountIndex: keys.indexOf(account), mint: "M", ...(t.owner && { owner: t.owner }), uiTokenAmount: { amount: String(amount), decimals: 6 } }];
    });
  return {
    slot: tx.slot,
    blockTime: 1_700_000_000 + tx.slot - S,
    transaction: { signatures: [tx.signature], message: { accountKeys: tx.keys } },
    meta: {
      err: tx.failed ? { InstructionError: [0, { Custom: 1 }] } : null,
      fee: 5000,
      preBalances: keys.map((k) => tx.lamports?.[k]?.[0] ?? 1_000_000n),
      postBalances: keys.map((k) => tx.lamports?.[k]?.[1] ?? 1_000_000n),
      preTokenBalances: tokenBalances("pre"),
      postTokenBalances: tokenBalances("post"),
      loadedAddresses: { writable: tx.loaded ?? [], readonly: [] },
    },
  };
}

const byPosition = (a: ChainTx, b: ChainTx) => a.slot - b.slot || a.index - b.index;

/**
 * A Helius node holding `txs`: the standard methods `rpc({ kind: "solana" })` calls (`getTransaction` without
 * `transactionIndex`) and `getTransactionsForAddress` as Helius documents it.
 */
function node(txs: ChainTx[], { pageSize = 1000, withIndex = true, override }: NodeOptions = {}) {
  const calls: Array<{ method: string; params: any[] }> = [];
  const touches = (tx: ChainTx, account: string) => allKeys(tx).includes(account);
  /** Token accounts each wallet owns in some transaction's token balances. */
  const ownedBy = (wallet: string) => new Set(txs.flatMap((tx) => Object.entries(tx.tokens ?? {}).filter(([, t]) => t.owner === wallet).map(([account]) => account)));
  const lastTouch = (account: string) => txs.filter((tx) => tx.tokens?.[account]).sort(byPosition).at(-1);

  function history(address: string, config: any) {
    const owned = ownedBy(address);
    const { slot, tokenAccounts } = config.filters;
    const matches = txs
      .filter((tx) => touches(tx, address) || (tokenAccounts === "all" && [...owned].some((a) => touches(tx, a))))
      .filter((tx) => tx.slot >= slot.gte && tx.slot < slot.lt)
      .sort(byPosition);
    const [afterSlot, afterIndex] = (config.paginationToken ?? "-1:-1").split(":").map(Number);
    const rest = matches.filter((tx) => tx.slot > afterSlot || (tx.slot === afterSlot && tx.index > afterIndex));
    const page = rest.slice(0, Math.min(config.limit, pageSize));
    const last = page.at(-1);
    const signature = (tx: ChainTx) => ({ signature: tx.signature, slot: tx.slot, transactionIndex: tx.index, err: null, memo: null, blockTime: raw(tx).blockTime, confirmationStatus: "confirmed" });
    const full = (tx: ChainTx) => ({ ...raw(tx), ...(withIndex && { transactionIndex: tx.index }) });
    return {
      data: config.transactionDetails === "signatures" ? page.map(signature) : page.map(full),
      paginationToken: rest.length > page.length && last ? `${last.slot}:${last.index}` : null,
    };
  }

  function answer(method: string, params: any[]): unknown {
    if (method === "getSlot") return S + 1_000;
    if (method === "getTransactionsForAddress") return history(params[0], params[1]);
    if (method === "getTransaction") return raw(txs.find((tx) => tx.signature === params[0])!);
    if (method === "getBlock") {
      const signatures = Array.from({ length: 10 }, (_, i) => `filler-${params[0]}-${i}`);
      for (const tx of txs.filter((t) => t.slot === params[0])) signatures[tx.index] = tx.signature;
      return { signatures };
    }
    if (method === "getTokenAccountsByOwner") {
      if (params[1].programId !== TOKEN_PROGRAM) return { value: [] };
      const open = [...ownedBy(params[0])].filter((a) => {
        const t = lastTouch(a)?.tokens?.[a];
        return t?.post !== undefined && t.owner === params[0];
      });
      return { value: open.map((pubkey) => ({ pubkey })) };
    }
    if (method === "getSignaturesForAddress") {
      const newest = txs.filter((tx) => touches(tx, params[0])).sort(byPosition).reverse();
      const start = params[1].before ? newest.findIndex((tx) => tx.signature === params[1].before) + 1 : 0;
      return newest.slice(start, start + params[1].limit).map((tx) => ({ signature: tx.signature, slot: tx.slot }));
    }
    throw new Error(`unexpected ${method}`);
  }

  const fake = (async (_url: string, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init!.body));
    calls.push({ method, params });
    return override?.(method, params) ?? new Response(json({ jsonrpc: "2.0", id: 1, result: answer(method, params) }));
  }) as typeof fetch;
  return { fake, calls };
}

async function batches(source: SolanaSource, query: SolanaQuery): Promise<SolanaBatch[]> {
  const out: SolanaBatch[] = [];
  for await (const batch of source.fetch(query)) out.push(batch);
  return out;
}

/** Consecutive batches as one, for sources that split a range differently. */
function merged(list: SolanaBatch[]): SolanaBatch {
  return {
    fromBlock: list[0]!.fromBlock,
    nextBlock: list.at(-1)!.nextBlock,
    blocks: list.flatMap((b) => b.blocks),
    transactions: list.flatMap((b) => b.transactions),
    balances: list.flatMap((b) => b.balances),
    instructions: list.flatMap((b) => b.instructions),
    logs: list.flatMap((b) => b.logs),
    joinedBalances: list.flatMap((b) => b.joinedBalances),
  };
}

const W = "Wallet1111111111111111111111111111111111111";
const W2 = "Wallet2222222222222222222222222222222222222";
const X = "Other11111111111111111111111111111111111111";

describe("helius()", () => {
  it("pages each wallet oldest first over the query's slots, with its token accounts", async () => {
    const own = (n: number): ChainTx => ({ signature: `own${n}`, slot: S + n, index: 0, keys: [W, X], lamports: { [W]: [100n, 90n] } });
    const { fake, calls } = node([own(-1), own(0), own(1), own(2), own(3), own(4), own(5)], { pageSize: 2 });
    const [batch] = await batches(helius({ url: URL_WITH_KEY, fetch: fake }), { fromBlock: S, toBlock: S + 5, addresses: [W] });
    expect(batch!.transactions.map((t) => t.signature)).toEqual(["own0", "own1", "own2", "own3", "own4"]);
    expect([batch!.fromBlock, batch!.nextBlock]).toEqual([S, S + 5]);
    const pages = calls.filter((c) => c.method === "getTransactionsForAddress");
    expect(pages.map((c) => c.params[1].paginationToken)).toEqual([undefined, `${S + 1}:0`, `${S + 3}:0`]);
    expect(pages[0]!.params).toEqual([
      W,
      { transactionDetails: "full", sortOrder: "asc", limit: 1000, encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed", filters: { slot: { gte: S, lt: S + 5 }, tokenAccounts: "all" } },
    ]);
    expect(calls.map((c) => c.method)).not.toContain("getBlock");
  });

  it("reads a transaction two wallets share once", async () => {
    const { fake } = node([
      { signature: "shared", slot: S + 1, index: 0, keys: [W, W2], lamports: { [W]: [100n, 50n], [W2]: [0n, 45n] } },
      { signature: "mine", slot: S + 2, index: 0, keys: [W2, X], lamports: { [W2]: [45n, 40n] } },
    ]);
    const [batch] = await batches(helius({ url: URL_WITH_KEY, fetch: fake }), { fromBlock: S, toBlock: S + 10, addresses: [W, W2] });
    expect(batch!.transactions.map((t) => t.signature)).toEqual(["shared", "mine"]);
    expect(batch!.balances.map((b) => [b.signature, b.account])).toEqual([
      ["shared", W],
      ["shared", W2],
      ["mine", W2],
    ]);
  });

  it("reads slots below 111,491,819 like rpc({ kind: \"solana\" }), on the same URL", async () => {
    const A = "TokenAcc111111111111111111111111111111111111";
    const { fake, calls } = node([
      { signature: "old", slot: 111_491_500, index: 0, keys: [W, X], lamports: { [W]: [100n, 90n] } },
      // Before the owner field: rpc() knows A is W's from getTokenAccountsByOwner.
      { signature: "oldReceived", slot: 111_491_600, index: 0, keys: [X, A], tokens: { [A]: { pre: 0n, post: 3n } } },
      { signature: "new", slot: 111_491_900, index: 0, keys: [X, A], tokens: { [A]: { owner: W, pre: 3n, post: 5n } } },
    ]);
    const source = helius({ url: URL_WITH_KEY, fetch: fake });
    const list = await batches(source, { fromBlock: 111_491_000, toBlock: 111_492_000, addresses: [W] });
    expect(list.map((b) => [b.fromBlock, b.nextBlock, b.transactions.map((t) => t.signature)])).toEqual([
      [111_491_000, 111_491_819, ["old", "oldReceived"]],
      [111_491_819, 111_492_000, ["new"]],
    ]);
    expect(list[0]!.balances.at(-1)!.token!.owner).toBe(W);
    expect(calls.filter((c) => c.method === "getTransactionsForAddress").map((c) => c.params[1])).toEqual([
      { transactionDetails: "signatures", limit: 1, commitment: "confirmed", filters: { slot: { gte: 111_491_000, lt: 111_491_819 } } },
      expect.objectContaining({ transactionDetails: "full", filters: { slot: { gte: 111_491_819, lt: 111_492_000 }, tokenAccounts: "all" } }),
    ]);
    calls.length = 0;
    await batches(source, { fromBlock: 111_000_000, toBlock: 111_491_819, addresses: [W] });
    expect(calls.filter((c) => c.method === "getTransactionsForAddress").map((c) => c.params[1].transactionDetails)).toEqual(["signatures"]);
  });

  it("reads below slot 111,491,819 only the wallets with a transaction of their own there", async () => {
    const { fake, calls } = node([
      { signature: "old", slot: 100_000_000, index: 0, keys: [W, X], lamports: { [W]: [100n, 90n] } },
      { signature: "recent", slot: S + 1, index: 0, keys: [W2, X], lamports: { [W2]: [100n, 90n] } },
    ]);
    const list = await batches(helius({ url: URL_WITH_KEY, fetch: fake }), { fromBlock: 0, toBlock: S + 10, addresses: [W, W2] });
    expect(list.map((b) => [b.fromBlock, b.nextBlock, b.transactions.map((t) => t.signature)])).toEqual([
      [0, 111_491_819, ["old"]],
      [111_491_819, S + 10, ["recent"]],
    ]);
    const askedOver = (method: string) => [...new Set(calls.filter((c) => c.method === method).map((c) => c.params[0]))];
    expect([askedOver("getTokenAccountsByOwner"), askedOver("getSignaturesForAddress"), askedOver("getTransaction")]).toEqual([[W], [W], ["old"]]);
  });

  it("starts at the query's slot without rpc() when no wallet has a transaction below 111,491,819", async () => {
    const own = (n: number): ChainTx => ({ signature: `own${n}`, slot: S + n, index: 0, keys: [W, X], lamports: { [W]: [100n, 90n] } });
    const { fake, calls } = node(Array.from({ length: 500 }, (_, n) => own(n)));
    const source = helius({ url: URL_WITH_KEY, fetch: fake });
    const asked = () => calls.map((c) => [c.method, c.params[1]?.transactionDetails, c.params[1]?.filters?.slot]);
    const list = await batches(source, { fromBlock: 0, toBlock: S + 10, addresses: [W] });
    expect(list.map((b) => [b.fromBlock, b.nextBlock, b.transactions.length])).toEqual([[0, S + 10, 10]]);
    expect(asked()).toEqual([
      ["getTransactionsForAddress", "signatures", { gte: 0, lt: 111_491_819 }],
      ["getTransactionsForAddress", "full", { gte: 111_491_819, lt: S + 10 }],
    ]);
    calls.length = 0;
    const old = await batches(source, { fromBlock: 0, toBlock: 111_491_819, addresses: [W] });
    expect(old.map((b) => [b.fromBlock, b.nextBlock, b.transactions.length])).toEqual([[0, 111_491_819, 0]]);
    expect(asked()).toEqual([["getTransactionsForAddress", "signatures", { gte: 0, lt: 111_491_819 }]]);
  });

  it("orders transactions of one slot by the block when a page has no index", async () => {
    const { fake, calls } = node(
      [
        { signature: "second", slot: S + 5, index: 7, keys: [W], lamports: { [W]: [9n, 8n] } },
        { signature: "first", slot: S + 5, index: 2, keys: [W], lamports: { [W]: [10n, 9n] } },
      ],
      { withIndex: false },
    );
    const [batch] = await batches(helius({ url: URL_WITH_KEY, fetch: fake }), { fromBlock: S, toBlock: S + 10, addresses: [W] });
    expect(batch!.transactions.map((t) => [t.signature, t.transactionIndex])).toEqual([
      ["first", 2],
      ["second", 7],
    ]);
    expect(calls.filter((c) => c.method === "getBlock").map((c) => c.params[0])).toEqual([S + 5]);
  });

  it("keeps lamports exact past 2^53", async () => {
    const big = 2n ** 60n + 1n;
    const { fake } = node([{ signature: "rich", slot: S + 1, index: 0, keys: [W, X], lamports: { [W]: [big, big - 5000n] } }]);
    const [batch] = await batches(helius({ url: URL_WITH_KEY, fetch: fake }), { fromBlock: S, toBlock: S + 10, addresses: [W] });
    expect(batch!.balances[0]!.lamports).toEqual({ pre: big, post: big - 5000n });
  });

  it("throws the node's errors with the method that failed", async () => {
    const rejecting = (response: () => Response) => node([], { override: (method) => (method === "getTransactionsForAddress" ? response() : undefined) }).fake;
    const query = { fromBlock: S, toBlock: S + 10, addresses: [W] };
    const invalid = rejecting(() => new Response(json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" } })));
    await expect(batches(helius({ url: URL_WITH_KEY, fetch: invalid }), query)).rejects.toThrow("helius(mainnet.helius-rpc.com) getTransactionsForAddress: -32602 Invalid params");
    const unauthorized = rejecting(() => new Response("Unauthorized", { status: 401 }));
    await expect(batches(helius({ url: URL_WITH_KEY, fetch: unauthorized }), query)).rejects.toThrow(new Error("mainnet.helius-rpc.com: HTTP 401 Unauthorized"));
  });

  it("refuses program queries", async () => {
    const { fake } = node([]);
    const query = { fromBlock: S, toBlock: S + 10, addresses: [W], logs: [{ programs: [X], kinds: ["data" as const], balances: false }] };
    await expect(batches(helius({ url: URL_WITH_KEY, fetch: fake }), query)).rejects.toThrow(/need hypersync\(\{ kind: "solana" \}\)/);
  });

  it("is a Solana source named after the host, with the head from getSlot", async () => {
    const { fake, calls } = node([]);
    const source = helius({ url: URL_WITH_KEY, fetch: fake });
    expect(source.kind).toBe("solana");
    expect(source.name).toBe("helius(mainnet.helius-rpc.com)");
    expect(union(hypersync({ kind: "solana" }), source).name).toBe("union(hypersync(solana.hypersync.xyz), helius(mainnet.helius-rpc.com))");
    expect(await source.getHeight()).toBe(S + 1_000);
    expect(calls).toEqual([{ method: "getSlot", params: [{ commitment: "confirmed" }] }]);
  });
});

describe("helius() and rpc({ kind: \"solana\" })", () => {
  const A1 = "TokenAccW1111111111111111111111111111111111";
  const A2 = "TokenAccW2222222222222222222222222222222222";
  const A3 = "TokenAccW1Closed11111111111111111111111111111";
  const XA = "TokenAccX11111111111111111111111111111111111";
  const RENT = 2_039_280n;
  const chain = (base: number): ChainTx[] => [
    { signature: "paid", slot: base + 1, index: 3, keys: [W, X], lamports: { [W]: [10_000_000n, 8_995_000n], [X]: [0n, 1_000_000n] } },
    { signature: "failed", slot: base + 1, index: 1, keys: [W, X], failed: true, lamports: { [W]: [10_005_000n, 10_000_000n] } },
    { signature: "received", slot: base + 2, index: 0, keys: [X, XA, A1, TOKEN_PROGRAM], tokens: { [XA]: { owner: X, pre: 9n, post: 2n }, [A1]: { owner: W, pre: 0n, post: 7n } } },
    { signature: "rentOnly", slot: base + 3, index: 0, keys: [X, A1], lamports: { [A1]: [RENT, RENT + 1n] }, tokens: { [A1]: { owner: W, pre: 7n, post: 7n } } },
    { signature: "unchanged", slot: base + 4, index: 0, keys: [X, A1], tokens: { [A1]: { owner: W, pre: 7n, post: 7n } } },
    { signature: "loaded", slot: base + 5, index: 0, keys: [X], loaded: [W2], lamports: { [W2]: [2n ** 60n, 2n ** 60n + 5n] } },
    {
      signature: "between",
      slot: base + 6,
      index: 2,
      keys: [W, A1, A2, W2, TOKEN_PROGRAM],
      lamports: { [W]: [8_995_000n, 6_950_720n], [A2]: [0n, RENT] },
      tokens: { [A1]: { owner: W, pre: 7n, post: 2n }, [A2]: { owner: W2, post: 5n } },
    },
    { signature: "intoClosed", slot: base + 7, index: 0, keys: [X, A3], tokens: { [A3]: { owner: W, pre: 0n, post: 4n } } },
    { signature: "unrelated", slot: base + 8, index: 0, keys: [X, XA], lamports: { [X]: [5n, 4n] } },
    { signature: "close", slot: base + 20, index: 0, keys: [W, A3], lamports: { [W]: [6_950_720n, 8_990_000n], [A3]: [RENT, 0n] }, tokens: { [A3]: { owner: W, pre: 0n } } },
  ];

  it("build the same batch from the same transactions", async () => {
    const { fake } = node(chain(S));
    const query = { fromBlock: S, toBlock: S + 10, addresses: [W, W2] };
    const fromHelius = await batches(helius({ url: URL_WITH_KEY, fetch: fake }), query);
    const fromRpc = await batches(rpc({ kind: "solana", url: URL_WITH_KEY, fetch: fake }), query);
    expect(fromHelius).toEqual(fromRpc);
    expect(fromHelius[0]!.transactions.map((t) => t.signature)).toEqual(["failed", "paid", "received", "rentOnly", "loaded", "between", "intoClosed"]);
    expect(fromHelius[0]!.transactions[0]).toMatchObject({ success: false, fee: 5000n, feePayer: W });
  });

  it("build the same rows across slot 111,491,819", async () => {
    const { fake } = node(chain(111_491_815));
    const query = { fromBlock: 111_491_810, toBlock: 111_491_830, addresses: [W, W2] };
    const fromHelius = await batches(helius({ url: URL_WITH_KEY, fetch: fake }), query);
    const [fromRpc] = await batches(rpc({ kind: "solana", url: URL_WITH_KEY, fetch: fake }), query);
    expect(fromHelius.length).toBe(2);
    expect(merged(fromHelius)).toEqual(fromRpc);
  });
});

const HELIUS_URL = process.env.HELIUS_URL ?? "";

describe.skipIf(HELIUS_URL === "")("helius() and rpc({ kind: \"solana\" }) on mainnet (HELIUS_URL)", () => {
  // A quiet wallet (a few dozen transactions since): rpc() reads all of them to find closed token accounts.
  const wallet = "AHgBtkGpvSTSbrGmyfQGUJ4ySP27J1Ut3TU4vkkDvASx";

  it("build the same batch for a wallet's December 2025 slots", async () => {
    const query = { fromBlock: 385_990_000, toBlock: 386_010_000, addresses: [wallet] };
    const fromHelius = merged(await batches(helius({ url: HELIUS_URL }), query));
    const fromRpc = merged(await batches(rpc({ kind: "solana", url: HELIUS_URL }), query));
    expect(fromHelius).toEqual(fromRpc);
    // Slot 386,000,000 sends it tokens without naming the wallet.
    expect(fromHelius.balances.some((b) => b.slot === 386_000_000 && b.token?.owner === wallet)).toBe(true);
  });
});
