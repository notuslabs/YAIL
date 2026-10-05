import { describe, expect, it } from "vitest";
import { union } from "../src/sources/union.js";
import { hypersyncSolana } from "../src/sources/hypersync-solana.js";
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

describe("hypersyncSolana()", () => {
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
    const source = hypersyncSolana({ apiToken: "t", fetch: fake });
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
    const source = hypersyncSolana({ apiToken: "t", fetch: fake, windowSlots: 100, concurrency: 3 });
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
    for await (const batch of hypersyncSolana({ apiToken: "t", fetch: fake }).fetch({ fromBlock: 1, toBlock: 2, addresses: ["W"] })) {
      expect(batch.balances[0]!.lamports).toEqual({ pre: BigInt(big), post: 1n });
      expect(batch.transactions[0]!.fee).toBe(5000n);
    }
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
