import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { union } from "../src/sources/union.js";
import { hypersync } from "../src/sources/hypersync.js";
import { rpc } from "../src/sources/rpc.js";
import { esplora } from "../src/sources/esplora.js";
import { helius } from "../src/sources/solana/helius.js";
import { cached, hashQuery } from "../src/sources/cached.js";
import { createDb } from "../src/db/client.js";
import { fixtureSource } from "../src/sources/fixture.js";
import { buildAddressQuery, buildPlans } from "../src/indexer/plan.js";
import { solanaAccountEvent } from "../src/indexer/events.js";
import { AddressRegistry } from "../src/addresses/registry.js";
import { createConfig } from "../src/config/index.js";
import type { BitcoinBatch, BitcoinQuery, BitcoinSource, SolanaBalance, SolanaQuery, SolanaSource } from "../src/sources/types.js";
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

describe("hypersync({ kind: \"solana\" }) programs", () => {
  const AMM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
  const CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
  const PUMP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

  /** A server that answers every selection with rows for a successful and a failed transaction, and records the bodies. */
  function server() {
    const bodies: any[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/height")) return new Response("1000");
      const body = JSON.parse(String(init!.body));
      bodies.push(body);
      const txs = [
        { signature: "OK", index: 0, success: true },
        { signature: "FAILED", index: 1, success: false },
      ];
      const programs: string[] = [...new Set<string>((body.instruction_calls ?? []).flatMap((s: { executing_account: string[] }) => s.executing_account))];
      const lines: Array<{ program_id: string[]; kind: string[] }> = body.logs ?? [];
      return new Response(
        JSON.stringify({
          next_slot: body.to_slot,
          blocks: [[{ slot: body.from_slot, block_time: 1 }]],
          transactions: [txs.map((t) => ({ slot: body.from_slot, transaction_index: t.index, transaction_id: t.signature, fee_payer: "W", success: t.success, fee: 5000 }))],
          instruction_calls: [txs.flatMap((t) => programs.map((program, n) => ({ slot: body.from_slot, transaction_index: t.index, instruction_address: [n], executing_account: program, account_arguments: [], data: "09" })))],
          logs: [txs.flatMap((t) => lines.flatMap((l) => l.program_id.flatMap((program) => l.kind.map((kind) => ({ slot: body.from_slot, transaction_index: t.index, instruction_address: [0], program_id: program, kind, message: `${program} ${kind}` })))))],
          account_activity: [body.field_selection.account_activity ? txs.map((t) => ({ slot: body.from_slot, transaction_index: t.index, transaction_id: t.signature, account: "W", pre_balance: 10, post_balance: 5 })) : []],
        }),
      );
    }) as typeof fetch;
    return { fake, bodies };
  }

  async function batches(source: SolanaSource, query: SolanaQuery) {
    const out = [];
    for await (const batch of source.fetch(query)) out.push(batch);
    return out;
  }

  it("never mixes wallet, instruction and log selections in one request, but an instruction filter's own log lines", async () => {
    const { fake, bodies } = server();
    await batches(hypersync({ kind: "solana", apiToken: "t", fetch: fake }), {
      fromBlock: 100,
      toBlock: 101,
      addresses: ["W"],
      instructions: [
        { programs: [AMM], discriminators: ["09", "2b04ed0b1ac91e62"], logKinds: ["log", "data"], balances: false },
        { programs: [PUMP], discriminators: ["e445a52e51cb9a1d"], isInner: true, logKinds: [], balances: false },
      ],
      logs: [{ programs: [CLMM], kinds: ["data"], balances: true }],
    });
    const selections = bodies.map((b) => ({ instruction_calls: b.instruction_calls, logs: b.logs, account_activity: b.account_activity }));
    expect(selections).toEqual([
      {
        instruction_calls: [
          { executing_account: [AMM], tx_success: true, d1: ["09"] },
          { executing_account: [AMM], tx_success: true, d8: ["2b04ed0b1ac91e62"] },
        ],
        logs: [{ program_id: [AMM], kind: ["log", "data"] }],
      },
      { instruction_calls: [{ executing_account: [PUMP], tx_success: true, is_inner: true, d8: ["e445a52e51cb9a1d"] }] },
      { logs: [{ program_id: [CLMM], kind: ["data"] }] },
      { account_activity: [{ account: ["W"] }, { owner: ["W"] }] },
    ]);
    expect(bodies.map((b) => Object.keys(b.field_selection).sort())).toEqual([
      ["block", "instruction_call", "log", "transaction"],
      ["block", "instruction_call", "transaction"],
      ["account_activity", "block", "log", "transaction"],
      ["account_activity", "block", "transaction"],
    ]);
  });

  it("drops program rows of failed transactions and keeps each log line once", async () => {
    const { fake } = server();
    const [batch] = await batches(hypersync({ kind: "solana", apiToken: "t", fetch: fake }), {
      fromBlock: 100,
      toBlock: 101,
      addresses: ["W"],
      instructions: [{ programs: [CLMM], discriminators: [], logKinds: ["log", "data"], balances: true }],
      logs: [{ programs: [CLMM], kinds: ["data"], balances: false }],
    });
    expect(batch!.instructions.map((i) => [i.signature, i.address, i.isInner])).toEqual([["OK", [0], false]]);
    expect(batch!.logs.map((l) => [l.signature, l.message])).toEqual([
      ["OK", `${CLMM} log`],
      ["OK", `${CLMM} data`],
    ]);
    expect(batch!.joinedBalances.map((b) => b.signature)).toEqual(["OK"]);
    // A failed transaction still charged its fee: the wallet's row stays.
    expect(batch!.balances.map((b) => b.signature)).toEqual(["OK", "FAILED"]);
    expect(batch!.transactions.map((t) => t.signature)).toEqual(["OK", "FAILED"]);
  });

  it("reads program queries in smaller windows than wallet ones", async () => {
    const { fake, bodies } = server();
    const source = hypersync({ kind: "solana", apiToken: "t", fetch: fake });
    await batches(source, { fromBlock: 0, toBlock: 25_000, addresses: [], logs: [{ programs: [CLMM], kinds: ["data"], balances: false }] });
    expect(bodies.map((b) => [b.from_slot, b.to_slot])).toEqual([
      [0, 10_000],
      [10_000, 20_000],
      [20_000, 25_000],
    ]);
    bodies.length = 0;
    await batches(source, { fromBlock: 0, toBlock: 25_000, addresses: ["W"] });
    expect(bodies.map((b) => [b.from_slot, b.to_slot])).toEqual([[0, 25_000]]);
  });

  it("is the only Solana source that serves programs: rpc() refuses them", async () => {
    const source = rpc({ kind: "solana", url: "http://node", fetch: (async () => new Response("{}")) as unknown as typeof fetch });
    const query = { fromBlock: 0, toBlock: 10, addresses: ["W"], logs: [{ programs: [CLMM], kinds: ["data" as const], balances: false }] };
    await expect(async () => {
      for await (const _ of source.fetch(query)) continue;
    }).rejects.toThrow(/need hypersync\(\{ kind: "solana" \}\)/);
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

  it("names only the node's host in HTTP errors, not the key in its path", async () => {
    const unauthorized = (async () => new Response("Unauthorized", { status: 401 })) as typeof fetch;
    const source = rpc({ kind: "solana", url: "https://solana-mainnet.g.alchemy.com/v2/secret-key", fetch: unauthorized });
    await expect(source.getHeight()).rejects.toThrow(new Error("solana-mainnet.g.alchemy.com: HTTP 401 Unauthorized"));
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

describe("onRequest", () => {
  /** A local HTTP server answering each request with `reply(path, body)`. */
  async function localServer(reply: (path: string, body: string) => string) {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        res.end(reply(req.url ?? "", body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
  }

  it("counts every HTTP attempt, retries included, until the listener is removed", async () => {
    const paths: string[] = [];
    const fake: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path.endsWith("/height") && paths.length === 1) return new Response("busy", { status: 503 });
      if (path.endsWith("/height")) return new Response("100");
      return new Response("[]");
    };
    const source = esplora({ url: "https://mempool.space/api", fetch: fake });
    const listener = vi.fn();
    const remove = source.onRequest?.(listener);
    expect(await source.getHeight()).toBe(100);
    for await (const batch of source.fetch({ fromBlock: 0, toBlock: 100, addresses: ["a", "b"] })) expect(batch.transactions).toEqual([]);
    expect(paths).toEqual(["/api/blocks/tip/height", "/api/blocks/tip/height", "/api/address/a/txs/chain", "/api/address/b/txs/chain"]);
    expect(listener).toHaveBeenCalledTimes(4);
    remove?.();
    await source.getHeight();
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("reads whole blocks through esplora() when asked, keeping the transactions of the addresses", async () => {
    const tx = (txid: string, from: string, to: string) => ({ txid, fee: 1, vin: [{ txid: "p", vout: 0, is_coinbase: false, prevout: { scriptpubkey_address: from, value: 10 } }], vout: [{ scriptpubkey_address: to, value: 9 }], status: { confirmed: true, block_height: 5, block_hash: "h5", block_time: 1 } });
    const block = Array.from({ length: 30 }, (_, i) => tx(`t${i}`, "x", "y"));
    block[3] = tx("spends", "a", "y");
    block[27] = tx("pays", "x", "b");
    const paths: string[] = [];
    const fake: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname.replace("/api", "");
      paths.push(path);
      if (path === "/block-height/5") return new Response("h5");
      if (path === "/block/h5") return new Response(JSON.stringify({ tx_count: 30 }));
      const start = Number(path.split("/").at(-1));
      return new Response(JSON.stringify(block.slice(start, start + 25)));
    };
    const source = esplora({ url: "https://mempool.space/api", fetch: fake });
    const txids: string[] = [];
    for await (const batch of source.fetch({ fromBlock: 5, toBlock: 6, addresses: ["a", "b"], wholeBlocks: true })) txids.push(...batch.transactions.map((t) => t.txid));
    expect(txids.sort()).toEqual(["pays", "spends"]);
    expect(paths).toEqual(["/block-height/5", "/block/h5", "/block/h5/txs/0", "/block/h5/txs/25"]);
  });

  it("counts helius() calls and those of the rpc() it reads below slot 111,491,819", async () => {
    const methods: string[] = [];
    const fake: typeof fetch = async (_input, init) => {
      const { method, params } = JSON.parse(String(init?.body));
      methods.push(method);
      const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
      if (method === "getTransactionsForAddress" && params[1].transactionDetails === "signatures") return reply({ data: [{ signature: "old" }] });
      if (method === "getTransactionsForAddress") return reply({ data: [], paginationToken: null });
      if (method === "getTokenAccountsByOwner") return reply({ value: [] });
      return reply([]);
    };
    const source = helius({ url: "https://mainnet.helius-rpc.com/?api-key=test", fetch: fake });
    const listener = vi.fn();
    source.onRequest?.(listener);
    for await (const batch of source.fetch({ fromBlock: 100_000_000, toBlock: 200_000_000, addresses: ["W"] })) expect(batch.balances).toEqual([]);
    expect(methods).toEqual(["getTransactionsForAddress", "getTokenAccountsByOwner", "getTokenAccountsByOwner", "getSignaturesForAddress", "getTransactionsForAddress"]);
    expect(listener).toHaveBeenCalledTimes(5);
  });

  it("counts Solana HyperSync and Solana RPC requests through union() and cached()", async () => {
    const fake: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/height")) return new Response("453000000");
      if (String(init?.body).includes("getSlot")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 452_000_000 }));
      return new Response(JSON.stringify({ next_slot: 2, blocks: [], transactions: [], account_activity: [] }));
    };
    const recent = hypersync({ kind: "solana", apiToken: "t", fetch: fake });
    const older = rpc({ kind: "solana", url: "https://solana-mainnet.g.alchemy.com/v2/key", fetch: fake });
    const source = cached(union(recent, older), { db: createDb({ url: "http://127.0.0.1:1" }), chain: "solana" });
    const listener = vi.fn();
    const remove = source.onRequest?.(listener);
    expect(await source.getHeight()).toBe(453_000_000);
    expect(await older.getHeight()).toBe(452_000_000);
    for await (const batch of recent.fetch({ fromBlock: 1, toBlock: 2, addresses: ["W"] })) expect(batch.nextBlock).toBe(2);
    expect(listener).toHaveBeenCalledTimes(3);
    remove?.();
    await recent.getHeight();
    await older.getHeight();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("counts EVM HyperSync and EVM RPC requests", async () => {
    const hypersyncServer = await localServer(() => JSON.stringify({ height: 123 }));
    const rpcServer = await localServer((_path, body) => {
      const calls: Array<{ id: number }> = [JSON.parse(body)].flat();
      return JSON.stringify(calls.map(({ id }) => ({ jsonrpc: "2.0", id, result: "0x10" })));
    });
    try {
      const listener = vi.fn();
      const evmHypersync = hypersync({ url: hypersyncServer.url, apiToken: "t" });
      const evmRpc = rpc({ url: rpcServer.url });
      evmHypersync.onRequest?.(listener);
      evmRpc.onRequest?.(listener);
      expect(await evmHypersync.getHeight()).toBe(123);
      expect(await evmRpc.getHeight()).toBe(16);
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      await hypersyncServer.close();
      await rpcServer.close();
    }
  });
});
