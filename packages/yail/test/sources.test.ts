import { describe, expect, it } from "vitest";
import { union } from "../src/sources/union.js";
import { hypersync } from "../src/sources/hypersync.js";
import { rpc } from "../src/sources/rpc.js";
import { hashQuery } from "../src/sources/cached.js";
import { fixtureSource } from "../src/sources/fixture.js";
import { buildAddressQuery, buildPlans } from "../src/indexer/plan.js";
import { solanaAccountEvent } from "../src/indexer/events.js";
import { AddressRegistry } from "../src/addresses/registry.js";
import { createConfig } from "../src/config/index.js";
import type { BitcoinBatch, BitcoinQuery, BitcoinSource, SolanaBalance } from "../src/sources/types.js";
import type { Db } from "../src/db/client.js";

/** A Bitcoin-shaped source that serves one empty batch per query and records what it was asked. */
function recording(name: string, firstBlock?: number) {
  const asked: Array<[number, number]> = [];
  let floorReads = 0;
  const source: BitcoinSource = {
    kind: "bitcoin",
    name,
    getHeight: async () => 1000,
    async *fetch(query: BitcoinQuery) {
      asked.push([query.fromBlock, query.toBlock]);
      yield { fromBlock: query.fromBlock, nextBlock: query.toBlock, transactions: [] } satisfies BitcoinBatch;
    },
  };
  if (firstBlock !== undefined) {
    source.firstBlock = async () => {
      floorReads++;
      return firstBlock;
    };
  }
  return { source, asked, floorReads: () => floorReads };
}

async function ranges(source: BitcoinSource, fromBlock: number, toBlock: number): Promise<Array<[number, number]>> {
  const out: Array<[number, number]> = [];
  for await (const b of source.fetch({ fromBlock, toBlock, addresses: ["a"] })) out.push([b.fromBlock, b.nextBlock]);
  return out;
}

describe("union()", () => {
  it("sends each range to the first source that holds it, never below a source's first block", async () => {
    const fast = recording("fast", 100);
    const full = recording("full");
    const u = union(fast.source, full.source);
    expect(await ranges(u, 0, 250)).toEqual([
      [0, 100],
      [100, 250],
    ]);
    expect(fast.asked).toEqual([[100, 250]]);
    expect(full.asked).toEqual([[0, 100]]);
    await ranges(u, 150, 200);
    await ranges(u, 10, 20);
    expect(fast.asked.every(([from]) => from >= 100)).toBe(true);
    expect(full.asked.at(-1)).toEqual([10, 20]);
    expect(u.name).toBe("union(fast, full)");
    expect(await u.firstBlock!()).toBe(0);
  });

  it("chains several floors", async () => {
    const a = recording("a", 300);
    const b = recording("b", 100);
    const c = recording("c");
    expect(await ranges(union(a.source, b.source, c.source), 50, 400)).toEqual([
      [50, 100],
      [100, 300],
      [300, 400],
    ]);
  });

  it("reads floors once an hour, not per query", async () => {
    const fast = recording("fast", 100);
    const u = union(fast.source, recording("full").source);
    for (let i = 0; i < 5; i++) await ranges(u, 0, 200);
    expect(fast.floorReads()).toBe(1);
  });

  it("fails loudly when no source holds a range", async () => {
    const u = union(recording("a", 100).source, recording("b", 50).source);
    await expect(ranges(u, 10, 60)).rejects.toThrow(/no source holds block 10/);
  });

  it("takes the head from the first source and refuses mixed kinds", async () => {
    const evm = fixtureSource({ version: 1, kind: "evm", height: 1, fromBlock: 0, toBlock: 1, blocks: [], transactions: [], logs: [] });
    expect(() => union(recording("btc").source as any, evm)).toThrow(/evm source/);
    expect(await union(recording("btc").source).getHeight()).toBe(1000);
  });
});

describe("hypersync({ kind: \"solana\" })", () => {
  /** A fake server that holds slots from `floor` on and counts requests. */
  function server(floor: number) {
    const bodies: any[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/height")) return new Response("453000000");
      const body = JSON.parse(String(init!.body));
      bodies.push(body);
      const next = body.from_slot >= floor ? body.to_slot : body.from_slot;
      return new Response(JSON.stringify({ next_slot: next, blocks: [], transactions: [], account_activity: [] }));
    }) as typeof fetch;
    return { fake, bodies };
  }

  it("finds where its history starts with tiny probes, then checks it with one", async () => {
    const { fake, bodies } = server(391_000_000);
    const source = hypersync({ kind: "solana", apiToken: "t", fetch: fake });
    expect(await source.firstBlock!()).toBe(391_000_000);
    expect(bodies.length).toBeLessThan(32);
    // Probes match nothing: they ask for no account activity at all.
    expect(bodies.every((b) => b.to_slot === b.from_slot + 1 && b.account_activity === undefined)).toBe(true);
    bodies.length = 0;
    expect(await source.firstBlock!()).toBe(391_000_000);
    expect(bodies.length).toBe(1);
  });

  it("reads long ranges in parallel windows, yielded in order", async () => {
    const { fake, bodies } = server(0);
    const source = hypersync({ kind: "solana", apiToken: "t", fetch: fake, windowSlots: 100, concurrency: 3 });
    const out: Array<[number, number]> = [];
    for await (const b of source.fetch({ fromBlock: 0, toBlock: 450, addresses: ["W"] })) out.push([b.fromBlock, b.nextBlock]);
    expect(out).toEqual([
      [0, 100],
      [100, 200],
      [200, 300],
      [300, 400],
      [400, 450],
    ]);
    expect(bodies[0].account_activity).toEqual([{ account: ["W"] }, { owner: ["W"] }]);
  });

  it("keeps lamports exact past 2^53", async () => {
    const big = "12345678901234567890";
    const fake = (async () =>
      new Response(
        `{"next_slot":2,"blocks":[[{"slot":1,"block_time":5}]],"transactions":[[{"slot":1,"transaction_index":0,"transaction_id":"S","fee_payer":"W","success":true,"fee":5000}]],"account_activity":[[{"slot":1,"transaction_index":0,"transaction_id":"S","account":"W","pre_balance":${big},"post_balance":1}]]}`,
      )) as unknown as typeof fetch;
    for await (const batch of hypersync({ kind: "solana", apiToken: "t", fetch: fake }).fetch({ fromBlock: 1, toBlock: 2, addresses: ["W"] })) {
      expect(batch.balances[0]!.lamports).toEqual({ pre: BigInt(big), post: 1n });
      expect(batch.transactions[0]!.fee).toBe(5000n);
    }
  });
});

describe("sources by provider", () => {
  it("pick the chain with kind, EVM by default", () => {
    expect(hypersync({ url: "https://base.hypersync.xyz" }).kind).toBe("evm");
    expect(hypersync({ kind: "solana" }).kind).toBe("solana");
    expect(hypersync({ kind: "solana" }).name).toBe("hypersync(solana.hypersync.xyz)");
    expect(rpc({ url: "https://mainnet.base.org" }).kind).toBe("evm");
    const solana = rpc({ kind: "solana", url: "https://api.mainnet-beta.solana.com" });
    expect(solana.kind).toBe("solana");
    expect(union(hypersync({ kind: "solana" }), solana).name).toBe("union(hypersync(solana.hypersync.xyz), rpc(api.mainnet-beta.solana.com))");
  });
});

describe("rpc({ kind: \"solana\" })", () => {
  const W = "Wallet1111111111111111111111111111111111111";
  const A = "TokenAcc111111111111111111111111111111111111";
  /** A JSON-RPC node holding `txs`. `getTransaction` leaves `transactionIndex` out, like an undocumented field may be. */
  function node(txs: Array<{ signature: string; slot: number; keys: string[]; tokens: Array<[number, bigint, bigint]>; lamports?: Array<[bigint, bigint]> }>, blockOrder: Record<number, string[]>) {
    const calls: Array<[string, unknown]> = [];
    const fake = (async (_url: string, init?: RequestInit) => {
      const { method, params } = JSON.parse(String(init!.body));
      calls.push([method, params[0]]);
      const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
      if (method === "getTokenAccountsByOwner") return reply({ value: [] }); // A is closed
      if (method === "getSignaturesForAddress") {
        const [account, { before }] = params;
        const mine = txs.filter((t) => t.keys.includes(account)).sort((a, b) => b.slot - a.slot);
        return reply(before ? [] : mine.map((t) => ({ signature: t.signature, slot: t.slot })));
      }
      if (method === "getBlock") return reply({ signatures: blockOrder[params[0]] });
      const t = txs.find((x) => x.signature === params[0])!;
      const balances = (pick: 1 | 2) => t.tokens.map(([i, pre, post]) => ({ accountIndex: i, mint: "M", owner: W, uiTokenAmount: { amount: String(pick === 1 ? pre : post), decimals: 6 } }));
      return reply({
        slot: t.slot,
        blockTime: 1,
        transaction: { signatures: [t.signature], message: { accountKeys: t.keys } },
        meta: { err: null, fee: 5000, preBalances: t.keys.map((_, i) => Number(t.lamports?.[i]?.[0] ?? 0n)), postBalances: t.keys.map((_, i) => Number(t.lamports?.[i]?.[1] ?? 0n)), preTokenBalances: balances(1), postTokenBalances: balances(2) },
      });
    }) as typeof fetch;
    return { fake, calls };
  }

  it("finds a token account the wallet closed after the range, and remembers what it read", async () => {
    // A is created by the wallet at slot 10, receives a transfer naming only A at 20, is closed by the wallet at 30.
    const { fake, calls } = node(
      [
        { signature: "create", slot: 10, keys: [W, A], tokens: [[1, 0n, 0n]] },
        { signature: "transfer", slot: 20, keys: ["Sender111111111111111111111111111111111111", A], tokens: [[1, 0n, 7n]] },
        { signature: "close", slot: 30, keys: [W, A], tokens: [[1, 7n, 0n]], lamports: [[0n, 2n], [2n, 0n]] },
      ],
      { 20: ["other", "transfer"] },
    );
    const source = rpc({ kind: "solana", url: "http://node", fetch: fake });
    const read = async () => {
      const out = [];
      for await (const b of source.fetch({ fromBlock: 20, toBlock: 21, addresses: [W] })) out.push(...b.balances);
      return out;
    };
    expect(await read()).toEqual([{ signature: "transfer", slot: 20, transactionIndex: 1, account: A, token: { mint: "M", owner: W, decimals: 6, pre: 0n, post: 7n } }]);
    const closeReads = () => calls.filter(([m, p]) => m === "getTransaction" && p === "close").length;
    expect(closeReads()).toBe(1);
    await read();
    expect(closeReads()).toBe(1);
  });

  it("orders transactions of one slot by the block when getTransaction has no index", async () => {
    const { fake, calls } = node(
      [
        { signature: "first", slot: 5, keys: [W], tokens: [], lamports: [[10n, 9n]] },
        { signature: "second", slot: 5, keys: [W], tokens: [], lamports: [[9n, 8n]] },
      ],
      { 5: ["x", "first", "y", "second"] },
    );
    const txs = [];
    for await (const b of rpc({ kind: "solana", url: "http://node", fetch: fake }).fetch({ fromBlock: 0, toBlock: 10, addresses: [W] })) txs.push(...b.transactions);
    expect(txs.map((t) => [t.signature, t.transactionIndex])).toEqual([
      ["first", 1],
      ["second", 3],
    ]);
    expect(calls.filter(([m]) => m === "getBlock")).toEqual([["getBlock", 5]]);
  });
});

describe("Solana accounts", () => {
  const row = (account: string, extra: Partial<SolanaBalance>): SolanaBalance => ({ signature: "S", slot: 1, transactionIndex: 0, account, ...extra });

  it("gives a wallet its SOL and the tokens of the accounts it owns", () => {
    const rows = [
      row("W", { lamports: { pre: 100n, post: 40n } }),
      row("ata1", { lamports: { pre: 0n, post: 2n }, token: { mint: "USDC", owner: "W", decimals: 6, pre: 0n, post: 7n } }),
      row("ata2", { token: { mint: "BONK", owner: "OTHER", decimals: 5, pre: 9n, post: 0n } }),
    ];
    const event = solanaAccountEvent({ signature: "S", slot: 1, transactionIndex: 0, feePayer: "W", fee: 5n, success: true }, { slot: 1, time: 0 }, rows, "W")!;
    expect(event.lamports).toBe(-60n);
    expect(event.tokens).toEqual([{ account: "ata1", mint: "USDC", decimals: 6, delta: 7n }]);
    expect(event.balances.map((b) => b.account)).toEqual(["W", "ata1"]);
    expect(solanaAccountEvent(event.transaction, event.block, rows, "NOBODY")).toBeNull();
  });

  it("keeps base58 addresses as they are", async () => {
    const src = fixtureSource({ version: 1, kind: "solana", height: 10, fromBlock: 0, toBlock: 10, blocks: [], transactions: [], balances: [] });
    const wallet = "8dVSpuXXqZmvsTJbTTut7acjhxUmknABHR6RhSkPNawV";
    const config = createConfig({ database: { url: "http://x" }, chains: { solana: { id: "solana", source: src } }, accounts: { W: { chain: "solana", address: [wallet] } } });
    const plan = buildPlans(config, { handled: new Set(["W:transaction"]), resolveLatest: () => 10 }).get("solana")!;
    const registry = new AddressRegistry({} as Db, (_c, a) => a);
    expect(plan.kind).toBe("solana");
    expect(buildAddressQuery(plan, 0, 10, registry).addresses).toEqual([wallet]);
    expect(hashQuery({ fromBlock: 0, toBlock: 1, addresses: [wallet] } as any)).not.toBe(hashQuery({ fromBlock: 0, toBlock: 1, addresses: [wallet.toLowerCase()] } as any));
  });
});
