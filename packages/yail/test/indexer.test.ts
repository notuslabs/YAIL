import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseAbi } from "viem";
import { startTestClickHouse, type TestClickHouse } from "../src/testing/index.js";
import { createConfig, addressSet, factory } from "../src/config/index.js";
import { createIndexer } from "../src/indexer/indexer.js";
import { fixtureSource } from "../src/sources/fixture.js";
import { t, table } from "../src/schema/index.js";
import { sql } from "../src/db/sql.js";
import { internalTables } from "../src/db/index.js";
import type { DatabaseConfig } from "../src/db/client.js";
import type { EvmBatch, EvmQuery, EvmSource, FetchOptions } from "../src/sources/types.js";
import { requestListeners } from "../src/util.js";
import { FixtureBuilder, addr } from "./helpers.js";
import { AddressRegistry } from "../src/addresses/registry.js";

const erc20 = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const factoryAbi = parseAbi(["event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"]);

const ledger = table(
  "ledger",
  { chain: t.string(), wallet: t.address(), token: t.address(), txHash: t.hash(), logIndex: t.uint32(), delta: t.int256(), block: t.uint64(), mode: t.string() },
  { orderBy: ["wallet", "chain", "txHash", "logIndex"], scopes: { wallet: "wallet" } },
);
const native = table("native", { chain: t.string(), wallet: t.address(), txHash: t.hash(), direction: t.string(), value: t.int256() }, { orderBy: ["wallet", "txHash", "direction"], scopes: { wallet: "wallet" } });
const poolEvents = table("pool_events", { pool: t.address(), txHash: t.hash(), logIndex: t.uint32(), value: t.uint256() }, { orderBy: ["pool", "txHash", "logIndex"] });

const TOKEN = addr(0x100);
const FACTORY = addr(0x200);
const POOL_A = addr(0x300);
const POOL_B = addr(0x301);
const W1 = addr(0x1);
const W2 = addr(0x2);
const W3 = addr(0x3);
const OTHER = addr(0x9);

function fixtureBuilder(height: number) {
  const fb = new FixtureBuilder(height);
  fb.transfer(5, TOKEN, OTHER, W1, 100n);
  fb.transfer(10, TOKEN, W1, W2, 40n);
  fb.transfer(20, TOKEN, OTHER, W3, 7n); // W3 registered later -> must be backfilled
  fb.transfer(30, TOKEN, W3, W1, 2n);
  fb.tx(35, W1, OTHER, 5n); // native out
  fb.tx(36, OTHER, W2, 9n); // native in
  fb.poolCreated(40, FACTORY, addr(0x10), addr(0x11), 500, POOL_A);
  fb.transfer(40, POOL_A, addr(0x10), addr(0x11), 1n); // same block as creation: must be picked up by factory expansion
  fb.transfer(45, POOL_A, addr(0x10), addr(0x11), 2n);
  fb.transfer(46, POOL_B, addr(0x10), addr(0x11), 3n); // not a child -> ignored
  fb.poolCreated(50, FACTORY, addr(0x10), addr(0x12), 3000, POOL_B);
  fb.transfer(55, POOL_B, addr(0x10), addr(0x11), 4n); // now a child
  fb.transfer(60, TOKEN, W2, OTHER, 1n);
  fb.transfer(115, TOKEN, OTHER, W1, 3n); // above the finalized head (120 - 10): not indexed until the head moves
  return fb;
}

function buildFixture(height = 120) {
  return fixtureBuilder(height).build();
}

let ch: TestClickHouse;
beforeAll(async () => {
  ch = await startTestClickHouse();
});
afterAll(async () => {
  await ch.stop();
});

function makeIndexer(database: DatabaseConfig, opts: { fixture: ReturnType<typeof buildFixture>; source?: EvmSource; backfillSource?: EvmSource; cacheSource?: boolean; withFactory?: boolean; wholeBlocksWithin?: number }) {
  const config = createConfig({
    database,
    chains: { test: { id: 1337, source: opts.source ?? fixtureSource(opts.fixture, { blocksPerBatch: 25 }), backfillSource: opts.backfillSource, finality: 10, pollInterval: 10, wholeBlocksWithin: opts.wholeBlocksWithin } },
    addressSets: { wallets: { initial: [W1, W2] } },
    contracts: {
      Token: { abi: erc20, chain: "test", address: TOKEN, startBlock: 0, filter: [{ event: "Transfer", args: { from: addressSet("wallets") } }, { event: "Transfer", args: { to: addressSet("wallets") } }] },
      Pool: { abi: erc20, chain: "test", address: factory({ address: FACTORY, event: factoryAbi[0], parameter: "pool" }), startBlock: 0 },
    },
    accounts: { Wallets: { chain: "test", address: addressSet("wallets"), startBlock: 0 } },
    cache: { source: opts.cacheSource ?? false },
    server: { port: false },
    observability: { pretty: false, batchEvents: true },
  });
  const indexer = createIndexer({ config, schema: { ledger, native, poolEvents } });
  const seen: string[] = [];
  indexer.on("Token:Transfer", async ({ event, context }) => {
    seen.push(`${event.block.number}:${event.log.logIndex}`);
    let mode = "live";
    if (context.backfill) mode = "backfill";
    const rows = [];
    if (context.addresses.has("wallets", event.args.from)) rows.push({ chain: context.chain.name, wallet: event.args.from, token: event.address, txHash: event.log.transactionHash, logIndex: event.log.logIndex, delta: -event.args.value, block: BigInt(event.block.number), mode });
    if (context.addresses.has("wallets", event.args.to)) rows.push({ chain: context.chain.name, wallet: event.args.to, token: event.address, txHash: event.log.transactionHash, logIndex: event.log.logIndex, delta: event.args.value, block: BigInt(event.block.number), mode });
    context.db.insert(ledger).values(rows);
    context.log.set({ transfers: seen.length });
  });
  indexer.on("Wallets:transaction", async ({ event, context }) => {
    let value = event.transaction.value;
    if (event.direction === "from") value = -value;
    context.db.insert(native).values({ chain: context.chain.name, wallet: event.address, txHash: event.transaction.hash, direction: event.direction, value });
  });
  // A contract without handlers is not fetched at all, so leaving this out drops the factory from the plan.
  if (opts.withFactory !== false) {
    indexer.on("Pool:Transfer", async ({ event, context }) => {
      context.db.insert(poolEvents).values({ pool: event.address, txHash: event.log.transactionHash, logIndex: event.log.logIndex, value: event.args.value });
    });
  }
  return { indexer, seen };
}

/** A database the indexer has run to the fixture's finalized head (cursor 111), with W1 and W2 seeded. */
async function caughtUp(): Promise<DatabaseConfig> {
  const database = ch.database();
  const { indexer } = makeIndexer(database, { fixture: buildFixture() });
  await indexer.run();
  await indexer.db.close();
  return database;
}

/** `source` reporting a request through `onRequest` for each height it reads and each batch it yields, counted in `sent()`. */
function counting(source: EvmSource) {
  const listeners = requestListeners();
  let sent = 0;
  const send = () => {
    sent++;
    listeners.count();
  };
  const wrapped: EvmSource = {
    ...source,
    async getHeight() {
      send();
      return source.getHeight();
    },
    async *fetch(query, options) {
      for await (const batch of source.fetch(query, options)) {
        send();
        yield batch;
      }
    },
    onRequest: listeners.onRequest,
  };
  return { source: wrapped, sent: () => sent };
}

/** Records every fetch from `source`. `onBatch(call, batch)` runs before each batch of each fetch is handed over: it may throw, or never return. */
function intercepted(source: EvmSource, onBatch: (call: number, batch: number) => Promise<void> | void = () => {}) {
  const queries: EvmQuery[] = [];
  const wrapped: EvmSource = {
    ...source,
    async *fetch(query: EvmQuery, options?: FetchOptions): AsyncIterable<EvmBatch> {
      queries.push(query);
      const call = queries.length;
      let batch = 0;
      for await (const b of source.fetch(query, options)) {
        await onBatch(call, batch++);
        yield b;
      }
    },
  };
  return { queries, source: wrapped };
}

async function balances(indexer: ReturnType<typeof makeIndexer>["indexer"]) {
  const rows = await indexer.db.query<{ wallet: string; total: string; n: string }>(sql`SELECT wallet, sum(delta) AS total, count() AS n FROM ${ledger} FINAL GROUP BY wallet ORDER BY wallet`);
  return Object.fromEntries(rows.map((r) => [r.wallet, { total: BigInt(r.total), n: Number(r.n) }]));
}

it("resolves latest once per referenced chain, honoring per-chain overrides", async () => {
  const source = fixtureSource(buildFixture());
  Object.assign(source, { self: source });
  const getHeight = vi.spyOn(source, "getHeight");
  const idle = fixtureSource(buildFixture());
  const idleHeight = vi.spyOn(idle, "getHeight").mockRejectedValue(new Error("unavailable"));
  const config = createConfig({
    database: ch.database(),
    chains: { test: { id: 1337, source }, idle: { id: 1338, source: idle } },
    contracts: { Token: { abi: erc20, address: TOKEN, chain: { test: { startBlock: "latest" }, idle: { startBlock: 10 } } } },
    accounts: { Wallets: { address: W1, startBlock: "latest", chain: { test: {}, idle: { startBlock: 5 } } } },
    server: { port: false },
    observability: { pretty: false },
  });
  const indexer = createIndexer({ config, schema: {} });
  indexer.on("Token:Transfer", () => {});
  indexer.on("Wallets:transaction", () => {});
  try {
    await Promise.all([indexer.init(), indexer.init()]);
    expect(getHeight).toHaveBeenCalledTimes(1);
    expect(idleHeight).not.toHaveBeenCalled();
    const test = indexer.internals.plans.get("test")!;
    expect(test.contracts[0]!.startBlock).toBe(120);
    expect(test.accounts[0]!.startBlock).toBe(120);
    const idlePlan = indexer.internals.plans.get("idle")!;
    expect(idlePlan.contracts[0]!.startBlock).toBe(10);
    expect(idlePlan.accounts[0]!.startBlock).toBe(5);
  } finally {
    await indexer.db.close();
  }
});

describe("activity accounts", () => {
  const ROUTER = addr(0x500);
  const activity = table("activity", { wallet: t.address(), txHash: t.hash(), direction: t.string(), logs: t.uint32(), traces: t.uint32() }, { orderBy: ["wallet", "txHash"] });

  it.each([{ wholeBlocksWithin: undefined }, { wholeBlocksWithin: 1_000 }])("delivers every transaction that mentions a wallet, whole, once per wallet (wholeBlocksWithin $wholeBlocksWithin)", async ({ wholeBlocksWithin }) => {
    const fb = new FixtureBuilder(20);
    const inLog = fb.tx(5, OTHER, ROUTER, 0n);
    fb.transfer(5, TOKEN, OTHER, W1, 10n, inLog); // W1 only appears in a log topic
    fb.transfer(5, TOKEN, addr(0x10), addr(0x11), 1n, inLog); // unrelated log of the same transaction
    const inTrace = fb.tx(6, OTHER, ROUTER, 0n);
    fb.trace(inTrace, OTHER, ROUTER, 0n, []);
    fb.trace(inTrace, ROUTER, W2, 7n, [0]); // W2 only receives through an internal call
    const direct = fb.tx(7, W1, OTHER, 3n);
    fb.transfer(8, TOKEN, addr(0x10), addr(0x11), 1n); // touches no wallet
    const config = createConfig({
      database: ch.database(),
      chains: { test: { id: 1337, source: fixtureSource(fb.build()), finality: 0, wholeBlocksWithin } },
      addressSets: { wallets: { initial: [W1, W2] } },
      accounts: { Wallets: { chain: "test", address: addressSet("wallets"), startBlock: 0, activity: true } },
      server: { port: false },
      observability: { pretty: false },
    });
    const indexer = createIndexer({ config, schema: { activity } });
    indexer.on("Wallets:transaction", async ({ event, context }) => {
      context.db.insert(activity).values({ wallet: event.address, txHash: event.transaction.hash, direction: event.direction, logs: event.logs.length, traces: event.traces.length });
    });
    await indexer.run();
    const rows = await indexer.db.rows(activity);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        { wallet: W1, txHash: inLog.hash, direction: "activity", logs: 2, traces: 0 },
        { wallet: W1, txHash: direct.hash, direction: "from", logs: 0, traces: 0 },
        { wallet: W2, txHash: inTrace.hash, direction: "activity", logs: 0, traces: 2 },
      ]),
    );
    await indexer.db.close();
  });
});

describe("prefetch", () => {
  it("hands a batch's events to the prefetcher before any of their handlers run", async () => {
    const fb = new FixtureBuilder(20);
    const txs = [fb.tx(5, W1, OTHER, 1n), fb.tx(6, OTHER, W2, 2n), fb.tx(7, W1, OTHER, 3n)];
    const config = createConfig({
      database: ch.database(),
      chains: { test: { id: 1337, source: fixtureSource(fb.build(), { blocksPerBatch: 25 }), finality: 0 } },
      addressSets: { wallets: { initial: [W1, W2] } },
      accounts: { Wallets: { chain: "test", address: addressSet("wallets"), startBlock: 0 } },
      server: { port: false },
      observability: { pretty: false },
    });
    const indexer = createIndexer({ config, schema: {} });
    const calls: string[] = [];
    indexer.prefetch("Wallets:transaction", async ({ events }) => {
      calls.push(`prefetch ${events.map(({ transaction }) => transaction.hash).join(",")}`);
    });
    indexer.on("Wallets:transaction", async ({ event }) => {
      calls.push(`handle ${event.transaction.hash}`);
    });
    await indexer.run();
    expect(calls).toEqual([`prefetch ${txs.map(({ hash }) => hash).join(",")}`, ...txs.map(({ hash }) => `handle ${hash}`)]);
    await indexer.db.close();
  });
});

describe("indexer end-to-end (synthetic fixture)", () => {
  let database: ReturnType<TestClickHouse["database"]>;
  let indexer: ReturnType<typeof makeIndexer>["indexer"];
  beforeAll(() => {
    database = ch.database();
  });
  afterAll(async () => {
    await indexer?.db.close();
  });

  it("indexes seeded wallets, factory children, and stops at the finalized head", async () => {
    const made = makeIndexer(database, { fixture: buildFixture() });
    indexer = made.indexer;
    await indexer.run();
    const status = await indexer.status();
    expect(status.chains.test!.cursor).toBe(111); // height 120 - finality 10 => finalized 110, cursor = 111
    expect(status.chains.test!.caughtUp).toBe(true);
    expect(await balances(indexer)).toEqual({
      [W1]: { total: 100n - 40n + 2n, n: 3 },
      [W2]: { total: 40n - 1n, n: 2 },
    });
    // Every transaction sent by a wallet is an account event, including the zero-value ERC-20 transfer calls.
    const nat = await indexer.db.rows(native, sql`ORDER BY wallet, value`);
    expect(nat.map((r) => [r.wallet, r.direction, r.value])).toEqual([
      [W1, "from", -5n],
      [W1, "from", 0n],
      [W2, "from", 0n],
      [W2, "to", 9n],
    ]);
    const pools = await indexer.db.rows(poolEvents, sql`ORDER BY pool, _yail_block, log_index`);
    expect(pools.map((r) => [r.pool, r.value])).toEqual([
      [POOL_A, 1n],
      [POOL_A, 2n],
      [POOL_B, 4n],
    ]);
    // Wide events were emitted per batch with handler-provided fields.
    const events = indexer.observability.recentEvents(50);
    expect(events.some((e) => e.mode === "live" && typeof e.events === "number")).toBe(true);
    const cp = await indexer.db.rows(internalTables.checkpoints);
    expect(Number(cp[0]!.cursor)).toBe(111);
  });

  it("registers a new wallet, backfills its history and keeps it live; then reindexes it", async () => {
    // Move the head forward so the live loop has new blocks; the indexer resumes from the checkpoint.
    const fx = buildFixture();
    fx.height = 140;
    for (let n = 121; n <= 140; n++) fx.blocks.push({ number: n, hash: `0x${n.toString(16).padStart(64, "0")}`, timestamp: 1_700_000_000 + n * 2 });
    const made = makeIndexer(database, { fixture: fx });
    indexer = made.indexer;
    await indexer.init();
    expect(indexer.internals.runners.get("test")!.cursor).toBe(111);
    await indexer.addresses.register({ set: "wallets", address: W3 });
    await indexer.run();
    const status = await indexer.status();
    expect(status.chains.test!.cursor).toBe(131);
    const b = await balances(indexer);
    expect(b[W3]).toEqual({ total: 7n - 2n, n: 2 });
    expect(b[W1]).toEqual({ total: 100n - 40n + 2n + 3n, n: 4 }); // block 115 now final
    const w3rows = await indexer.db.rows(ledger, sql`WHERE wallet = ${W3} ORDER BY block`);
    expect(w3rows.map((r) => r.mode)).toEqual(["backfill", "backfill"]);
    const reg = indexer.addresses.list({ set: "wallets" });
    expect(reg.find((r) => r.address === W3)?.status).toBe("live");
    // The W1 -> W3 transfer at block 30 was already recorded for W1 (live) and now again for W3 (backfill): same tx, different wallet rows.
    const rowsBlock30 = await indexer.db.rows(ledger, sql`WHERE block = 30 ORDER BY wallet`);
    expect(rowsBlock30.map((r) => [r.wallet, r.delta])).toEqual([[W1, 2n], [W3, -2n]]);

    // Re-index W3: rows are deleted and rebuilt from its history.
    await indexer.db.command(sql`INSERT INTO ${ledger} (chain, wallet, token, tx_hash, log_index, delta, block, mode, _yail_chain, _yail_block) VALUES ('test', ${W3}, ${TOKEN}, '0xbogus', 0, 999, 1, 'garbage', 'test', 1)`);
    expect((await balances(indexer))[W3]!.n).toBe(3);
    await indexer.reindex({ chain: "test", scope: "wallet", value: W3 });
    await indexer.run();
    expect((await balances(indexer))[W3]).toEqual({ total: 5n, n: 2 });
    const jobs = await indexer.db.rows(internalTables.jobs, sql`ORDER BY created_at`);
    expect(jobs.map((j) => [j.kind, j.status])).toEqual([["backfill_address", "done"], ["reindex_scope", "done"]]);
  });

  it("re-indexes a block range idempotently", async () => {
    const made = makeIndexer(database, { fixture: buildFixture() });
    indexer = made.indexer;
    await indexer.init();
    const before = await balances(indexer);
    await indexer.reindex({ chain: "test", fromBlock: 0, toBlock: 50 });
    await indexer.run();
    expect(await balances(indexer)).toEqual(before);
  });

  it("serves the same data through the cached source wrapper", async () => {
    const db2 = ch.database();
    // Cache keys include the address-set membership at query time, so the factory (whose children join the set mid-run) is left out here (no Pool handler).
    const first = makeIndexer(db2, { fixture: buildFixture(), cacheSource: true, withFactory: false });
    await first.indexer.run();
    const cachedRows = await first.indexer.db.query<{ n: string }>(sql`SELECT count() AS n FROM ${internalTables.sourceCache}`);
    expect(Number(cachedRows[0]!.n)).toBeGreaterThan(0);
    const b1 = await balances(first.indexer);
    // Second run over a fresh handler set: reset the checkpoint and re-run; data must come from the cache (fixture with no logs).
    await first.indexer.db.command(sql`TRUNCATE TABLE ${internalTables.checkpoints}`);
    await first.indexer.db.command(sql`TRUNCATE TABLE ${ledger}`);
    const emptyFixture = buildFixture();
    emptyFixture.logs = [];
    emptyFixture.transactions = [];
    const second = makeIndexer(db2, { fixture: emptyFixture, cacheSource: true, withFactory: false });
    await second.indexer.run();
    expect(await balances(second.indexer)).toEqual(b1);
    expect(second.indexer.observability.metrics.counters.cacheHits).toBeGreaterThan(0);
    await second.indexer.db.close();
    await first.indexer.db.close();
  });
});

describe("source requests", () => {
  it("counts a source that is also the backfillSource once in /status, per chain", async () => {
    const counted = counting(fixtureSource(buildFixture(), { blocksPerBatch: 25 }));
    const { indexer } = makeIndexer(ch.database(), { fixture: buildFixture(), source: counted.source, backfillSource: counted.source });
    await indexer.run();
    const status = await indexer.status();
    expect(counted.sent()).toBeGreaterThan(1);
    expect(status.counters.sourceRequests).toBe(counted.sent());
    expect(status.chains.test?.sourceRequests).toBe(counted.sent());
    await indexer.db.close();
  });

  it("counts the backfillSource's requests in /status", async () => {
    const database = await caughtUp();
    const fixture = buildFixture(140);
    const live = counting(fixtureSource(fixture, { blocksPerBatch: 25 }));
    const history = counting(fixtureSource(fixture, { blocksPerBatch: 25 }));
    const { indexer } = makeIndexer(database, { fixture, source: live.source, backfillSource: history.source });
    await indexer.init();
    await indexer.addresses.register({ set: "wallets", address: W3 });
    await indexer.run();
    const status = await indexer.status();
    expect(history.sent()).toBeGreaterThan(0);
    expect(status.counters.sourceRequests).toBe(live.sent() + history.sent());
    expect(status.chains.test?.sourceRequests).toBe(live.sent() + history.sent());
    await indexer.db.close();
  });
});

describe("whole blocks near the head", () => {
  const isWhole = (q: EvmQuery) => q.logs.length === 1 && Object.keys(q.logs[0]!).length === 0;

  async function indexed(indexer: ReturnType<typeof makeIndexer>["indexer"]) {
    return {
      balances: await balances(indexer),
      native: await indexer.db.rows(native, sql`ORDER BY wallet, tx_hash, direction`),
      pools: await indexer.db.rows(poolEvents, sql`ORDER BY pool, tx_hash, log_index`),
    };
  }

  it("indexes from whole blocks exactly what the filtered queries index", async () => {
    const filtered = makeIndexer(ch.database(), { fixture: buildFixture() }).indexer;
    await filtered.run();
    const live = intercepted(fixtureSource(buildFixture(), { blocksPerBatch: 25 }));
    const whole = makeIndexer(ch.database(), { fixture: buildFixture(), source: live.source, wholeBlocksWithin: 1_000 }).indexer;
    await whole.run();
    expect(live.queries.some(isWhole)).toBe(true);
    expect(await indexed(whole)).toEqual(await indexed(filtered));
    await filtered.db.close();
    await whole.db.close();
  });

  it("matches a wallet registered at the head from the next poll", async () => {
    const fb = fixtureBuilder(140);
    fb.transfer(125, TOKEN, OTHER, W3, 1n);
    const fixture = fb.build();
    fixture.height = 130;
    const { indexer } = makeIndexer(await caughtUp(), { fixture, wholeBlocksWithin: 1_000 });
    await indexer.init();
    const runner = indexer.internals.runners.get("test")!;
    await runner.runLoop({ once: true });
    await indexer.addresses.register({ set: "wallets", address: W3 });
    fixture.height = 140;
    await runner.runLoop({ once: true });
    expect((await indexer.db.rows(ledger, sql`WHERE wallet = ${W3}`)).map((r) => [r.block, r.mode])).toEqual([[125n, "live"]]);
    await indexer.db.close();
  });

  it("keeps the filtered queries for ranges further from the head", async () => {
    const live = intercepted(fixtureSource(buildFixture(), { blocksPerBatch: 25 }));
    const { indexer } = makeIndexer(ch.database(), { fixture: buildFixture(), source: live.source, wholeBlocksWithin: 5 });
    await indexer.run();
    expect(live.queries.filter(isWhole)).toEqual([]);
    await indexer.db.close();
  });
});

describe("batched backfills", () => {
  const W4 = addr(0x4);

  function withW4() {
    const fb = fixtureBuilder(120);
    fb.transfer(25, TOKEN, OTHER, W4, 11n);
    return fb.build();
  }

  async function registerW3W4(backfillSource: EvmSource) {
    const { indexer } = makeIndexer(await caughtUp(), { fixture: withW4(), backfillSource });
    await indexer.init();
    await indexer.addresses.register([
      { set: "wallets", address: W3 },
      { set: "wallets", address: W4 },
    ]);
    await indexer.run();
    return indexer;
  }

  async function expectBackfilled(indexer: Awaited<ReturnType<typeof registerW3W4>>) {
    const b = await balances(indexer);
    expect([b[W3], b[W4]]).toEqual([
      { total: 5n, n: 2 },
      { total: 11n, n: 1 },
    ]);
    expect(indexer.addresses.list({ set: "wallets", status: "live" }).map((r) => r.address).sort()).toEqual([W1, W2, W3, W4]);
  }

  it("reads wallets registered together in one job and one query", async () => {
    const history = intercepted(fixtureSource(withW4(), { blocksPerBatch: 200 }));
    const indexer = await registerW3W4(history.source);
    expect(history.queries.map((q) => q.transactions)).toEqual([[{ from: [W3, W4] }, { to: [W3, W4] }]]);
    const jobs = await indexer.db.rows(internalTables.jobs);
    expect(jobs.map((j) => [j.status, j.payload.addresses])).toEqual([["done", [W3, W4]]]);
    await expectBackfilled(indexer);
    await indexer.db.close();
  });

  it("splits a job in halves when the source refuses its query as too large", async () => {
    const source = fixtureSource(withW4(), { blocksPerBatch: 200 });
    const refusing: EvmSource = {
      ...source,
      async *fetch(query, options) {
        if ((query.transactions[0]?.from?.length ?? 0) > 1) throw new Error("Payload is too large and query is using the minimum block range.");
        yield* source.fetch(query, options);
      },
    };
    const history = intercepted(refusing);
    const indexer = await registerW3W4(history.source);
    expect(history.queries.map((q) => q.transactions[0]?.from)).toEqual([[W3, W4], [W3], [W4]]);
    const jobs = await indexer.db.rows(internalTables.jobs, sql`ORDER BY created_at`);
    expect(jobs.map((j) => [j.status, j.attempts, j.payload.addresses])).toEqual([
      ["done", 1, [W3, W4]],
      ["done", 1, [W3]],
      ["done", 1, [W4]],
    ]);
    await expectBackfilled(indexer);
    await indexer.db.close();
  });
  it("still runs a job enqueued with one address, before backfills were batched", async () => {
    const { indexer } = makeIndexer(await caughtUp(), { fixture: withW4() });
    await indexer.init();
    await indexer.internals.registry.register({ set: "wallets", chain: "test", address: W4, adoptedAtBlock: 111 });
    const now = new Date();
    await indexer.db.insert(internalTables.jobs).values({ id: "legacy", chain: "test", kind: "backfill_address", payload: { set: "wallets", address: W4, fromBlock: 0, toBlock: 111 }, status: "pending", attempts: 0, error: "", createdAt: now, updatedAt: now });
    await indexer.run();
    expect((await balances(indexer))[W4]).toEqual({ total: 11n, n: 1 });
    expect(indexer.addresses.list({ set: "wallets" }).find((r) => r.address === W4)?.status).toBe("live");
    await indexer.db.close();
  });
});

describe("address registry", () => {
  it("picks up what another process registered since its last load", async () => {
    const { indexer } = makeIndexer(ch.database(), { fixture: buildFixture() });
    await indexer.init();
    const reads: boolean[] = [];
    const db = { ...indexer.db, rows: ((table, where, options) => (reads.push(where !== undefined), indexer.db.rows(table, where, options))) as typeof indexer.db.rows };
    const other = new AddressRegistry(db, (_chain, address) => address.toLowerCase());
    await other.load();
    expect(other.has("wallets", "test", W1)).toBe(true);
    await indexer.addresses.register({ set: "wallets", address: W3 });
    await other.load();
    expect(other.has("wallets", "test", W3)).toBe(true);
    expect(reads).toEqual([false, true]);
    await indexer.db.close();
  });
});

describe("backfillSource", () => {
  it("reads a registered wallet's history from backfillSource and live ranges from source", async () => {
    const database = await caughtUp();
    const fixture = buildFixture(140);
    const live = intercepted(fixtureSource(fixture, { blocksPerBatch: 25 }));
    const history = intercepted(fixtureSource(fixture, { blocksPerBatch: 25 }));
    const { indexer } = makeIndexer(database, { fixture, source: live.source, backfillSource: history.source });
    await indexer.init();
    await indexer.addresses.register({ set: "wallets", address: W3 });
    await indexer.run();
    expect(history.queries.map((q) => [q.fromBlock, q.toBlock, q.transactions])).toEqual([[0, 111, [{ from: [W3] }, { to: [W3] }]]]);
    expect(live.queries.length).toBeGreaterThan(0);
    expect(live.queries.filter((q) => q.fromBlock < 111)).toEqual([]);
    expect((await balances(indexer))[W3]).toEqual({ total: 5n, n: 2 });
    await indexer.db.close();
  });
});

describe("jobs", () => {
  afterEach(() => {
    useRealClock();
  });

  /**
   * Fake timers two hours behind, so the rows written on them never shadow the ones written in real time after them.
   * Returns a count of the timers set since, by delay.
   */
  function useFakeClock(): (delayMs: number) => number {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.now() - 2 * 3_600_000, shouldClearNativeTimers: true });
    const timers = vi.spyOn(globalThis, "setTimeout");
    return (delayMs) => timers.mock.calls.filter(([, ms]) => ms === delayMs).length;
  }

  function useRealClock() {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }

  /**
   * Fires due fake timers, moving the clock `stepMs` at a time, until `condition` holds. The ClickHouse client waits on
   * a 0 ms timer before every request, and a 0 ms timer set while timers fire is due 1 ms later, so a step is at least 1 ms.
   */
  async function until(condition: () => boolean, stepMs = 1) {
    const deadline = performance.now() + 20_000;
    while (!condition()) {
      if (performance.now() > deadline) throw new Error("condition not met within 20 s");
      await vi.advanceTimersByTimeAsync(stepMs);
    }
  }

  async function drive<T>(promise: Promise<T>, stepMs = 1): Promise<T> {
    let settled = false;
    promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    await until(() => settled, stepMs);
    return promise;
  }

  /** Registers W3 on a caught-up database and starts its backfill job (W3 has history at blocks 20 and 30). */
  async function backfillW3(database: DatabaseConfig, fixture: ReturnType<typeof buildFixture>, backfillSource: EvmSource) {
    const made = makeIndexer(database, { fixture, backfillSource });
    await made.indexer.init();
    await made.indexer.addresses.register({ set: "wallets", address: W3 });
    await made.indexer.internals.runners.get("test")!.runLoop({ once: true });
    const jobs = made.indexer.internals.jobs.get("test")!;
    jobs.start();
    return { ...made, jobs };
  }

  it("retries a failed job after 30 s, then 60 s, until it succeeds", async () => {
    const database = await caughtUp();
    const history = intercepted(fixtureSource(buildFixture(), { blocksPerBatch: 25 }), (call) => {
      if (call <= 2) throw new Error("source unavailable");
    });
    const scheduled = useFakeClock();
    const { indexer, jobs } = await drive(backfillW3(database, buildFixture(), history.source));
    for (const delayMs of [30_000, 60_000]) {
      await until(() => scheduled(delayMs) === 1);
      await vi.advanceTimersByTimeAsync(delayMs);
    }
    await until(() => jobs.pending === 0);
    await drive(jobs.stop(), 1_000);
    expect([30_000, 60_000, 120_000].map(scheduled)).toEqual([1, 1, 0]);
    useRealClock();
    expect(history.queries).toHaveLength(3);
    const [job] = await indexer.db.rows(internalTables.jobs);
    expect([job!.status, job!.attempts]).toEqual(["done", 3]);
    expect((await balances(indexer))[W3]).toEqual({ total: 5n, n: 2 });
    await indexer.db.close();
  });

  it("keeps an address live when its backfill fails for good, and re-runs its history when it is registered again", async () => {
    const database = await caughtUp();
    const fb = fixtureBuilder(140);
    fb.transfer(125, TOKEN, OTHER, W3, 1n);
    const fixture = fb.build();
    fixture.height = 120;
    let failing = true;
    const history = intercepted(fixtureSource(fixture, { blocksPerBatch: 25 }), () => {
      if (failing) throw new Error("source unavailable");
    });
    const scheduled = useFakeClock();
    const { indexer, jobs, seen } = await drive(backfillW3(database, fixture, history.source));
    const delays = [30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000];
    for (const delayMs of delays) {
      await until(() => scheduled(delayMs) === 1);
      await vi.advanceTimersByTimeAsync(delayMs);
    }
    await until(() => jobs.pending === 0);
    await drive(jobs.stop(), 1_000);
    expect(scheduled(3_840_000)).toBe(0);
    useRealClock();
    expect(history.queries).toHaveLength(delays.length + 1);
    const [job] = await indexer.db.rows(internalTables.jobs);
    expect([job!.status, job!.attempts]).toEqual(["failed", 8]);
    expect(indexer.addresses.list({ set: "wallets", status: "failed" }).map((r) => r.address)).toEqual([W3]);
    expect(indexer.internals.registry.live("wallets", "test")).toContain(W3);

    fixture.height = 140;
    await indexer.internals.runners.get("test")!.runLoop({ once: true });
    expect((await indexer.db.rows(ledger, sql`WHERE wallet = ${W3}`)).map((r) => [r.block, r.mode])).toEqual([[125n, "live"]]);

    failing = false;
    await indexer.addresses.register({ set: "wallets", address: W3 });
    await indexer.run();
    expect(history.queries.at(-1)).toMatchObject({ fromBlock: 0, toBlock: 111 });
    expect(seen.filter((s) => s.startsWith("125:"))).toHaveLength(1);
    expect((await balances(indexer))[W3]).toEqual({ total: 7n - 2n + 1n, n: 3 });
    expect(indexer.addresses.list({ set: "wallets", status: "live" }).map((r) => r.address)).toContain(W3);
    await indexer.db.close();
  });

  it("retries a job that failed mid-range from the first block it had not written", async () => {
    const database = await caughtUp();
    const history = intercepted(fixtureSource(buildFixture(), { blocksPerBatch: 25 }), (call, batch) => {
      if (call === 1 && batch === 1) throw new Error("source unavailable");
    });
    const scheduled = useFakeClock();
    const { indexer, jobs } = await drive(backfillW3(database, buildFixture(), history.source));
    await until(() => scheduled(30_000) === 1);
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => jobs.pending === 0);
    await drive(jobs.stop(), 1_000);
    useRealClock();
    expect(history.queries.map((q) => q.fromBlock)).toEqual([0, 25]);
    expect((await balances(indexer))[W3]).toEqual({ total: 5n, n: 2 });
    await indexer.db.close();
  });

  it("resumes a killed backfill from the checkpoint it saved", async () => {
    const database = await caughtUp();
    let killed = false;
    const history = intercepted(fixtureSource(buildFixture(), { blocksPerBatch: 25 }), async (_call, batch) => {
      if (batch === 1) {
        killed = true;
        await new Promise(() => {});
      }
      vi.setSystemTime(Date.now() + 61_000);
    });
    useFakeClock();
    const first = await drive(backfillW3(database, buildFixture(), history.source));
    await until(() => killed);
    await drive(first.jobs.stop(), 1_000);
    useRealClock();
    await first.indexer.db.close();

    const resumed = intercepted(fixtureSource(buildFixture(), { blocksPerBatch: 25 }));
    const { indexer } = makeIndexer(database, { fixture: buildFixture(), backfillSource: resumed.source });
    await indexer.init();
    const [saved] = await indexer.db.rows(internalTables.jobs);
    expect([saved!.status, saved!.payload.fromBlock]).toEqual(["running", 25]);
    await indexer.run();
    expect(resumed.queries.map((q) => [q.fromBlock, q.toBlock])).toEqual([[25, 111]]);
    expect((await balances(indexer))[W3]).toEqual({ total: 5n, n: 2 });
    const [done] = await indexer.db.rows(internalTables.jobs);
    expect([done!.status, done!.attempts]).toEqual(["done", 2]);
    await indexer.db.close();
  });
});
