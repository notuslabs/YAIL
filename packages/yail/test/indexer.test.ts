import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAbi } from "viem";
import { startTestClickHouse, type TestClickHouse } from "../src/testing/index.js";
import { createConfig, addressSet, factory } from "../src/config/index.js";
import { createIndexer } from "../src/indexer/indexer.js";
import { fixtureSource } from "../src/sources/fixture.js";
import { t, table } from "../src/schema/index.js";
import { sql } from "../src/db/sql.js";
import { internalTables } from "../src/db/index.js";
import { FixtureBuilder, addr } from "./helpers.js";

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

function buildFixture() {
  const fb = new FixtureBuilder(120);
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
  return fb.build();
}

let ch: TestClickHouse;
beforeAll(async () => {
  ch = await startTestClickHouse();
});

function makeIndexer(database: ReturnType<TestClickHouse["database"]>, opts: { fixture: ReturnType<typeof buildFixture>; cacheSource?: boolean; withFactory?: boolean }) {
  const config = createConfig({
    database,
    chains: { test: { id: 1337, source: fixtureSource(opts.fixture, { blocksPerBatch: 25 }), finality: 10, pollInterval: 10 } },
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

async function balances(indexer: ReturnType<typeof makeIndexer>["indexer"]) {
  const rows = await indexer.db.query<{ wallet: string; total: string; n: string }>(sql`SELECT wallet, sum(delta) AS total, count() AS n FROM ${ledger} FINAL GROUP BY wallet ORDER BY wallet`);
  return Object.fromEntries(rows.map((r) => [r.wallet, { total: BigInt(r.total), n: Number(r.n) }]));
}

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
