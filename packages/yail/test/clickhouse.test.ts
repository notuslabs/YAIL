import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestClickHouse, type TestClickHouse } from "../src/testing/index.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { sql, type SqlFragment } from "../src/db/sql.js";
import { t, table, materializedView, view } from "../src/schema/index.js";
import { BatchWriter } from "../src/db/batch.js";
import { CacheRunner, seedCache } from "../src/cache/cached.js";
import { memory } from "../src/cache/stores.js";
import { createHttpClient } from "../src/http/client.js";
import { cached } from "../src/sources/cached.js";
import { fixtureSource, readFixture } from "../src/sources/fixture.js";
import { walletOf } from "../src/sources/solana/shared.js";
import type { BitcoinQuery, EvmQuery, RangeBatch, RangeQuery, SolanaQuery, Source } from "../src/sources/types.js";

const events = table(
  "events",
  { id: t.string(), wallet: t.address(), amount: t.int256(), at: t.dateTime64(3), flag: t.bool().default("false"), payload: t.json<{ a: number }>() },
  { orderBy: ["wallet", "id"], scopes: { wallet: "wallet" } },
);
const totals = table("totals", { wallet: t.address(), amount: t.int256() }, { orderBy: ["wallet"], engine: "SummingMergeTree", indexMeta: false });
const totalsMv = materializedView("totals_mv", { from: events, to: totals, query: sql`SELECT wallet, sum(amount) AS amount FROM ${events} GROUP BY wallet` });
const balances = view("balances", sql`SELECT wallet, sum(amount) AS amount FROM ${events} FINAL GROUP BY wallet`);
const positive = view("positive", sql`SELECT * FROM ${balances} WHERE amount > ${0n}`);

let ch: TestClickHouse;
let db: Db;

beforeAll(async () => {
  ch = await startTestClickHouse();
  db = createDb(ch.database());
  await migrate(db, { positive, events, totals, totalsMv, balances }); // a view listed before the view it reads
});
afterAll(async () => {
  await db?.close();
  await ch.stop();
});

describe("clickhouse", () => {
  it.each(["base-univ3-weth-usdc", "bitcoin-wallets", "solana-wallet-hypersync"])("replays a shorter range from cached %s data", async (name) => {
    const fixture = readFixture(new URL(`./fixtures/${name}.json`, import.meta.url).pathname);
    const options = { blocksPerBatch: fixture.toBlock - fixture.fromBlock };
    switch (fixture.kind) {
      case "evm": {
        const query: EvmQuery = { fromBlock: fixture.fromBlock, toBlock: fixture.toBlock, logs: [{}], transactions: [], includeLogTransactions: true };
        const heights = fixture.logs.map((l) => l.blockNumber);
        return expectCachedReplay(name, fixtureSource(fixture, options), (source, toBlock) => source.fetch({ ...query, toBlock }), query, heights, (batch) => batch.logs);
      }
      case "bitcoin": {
        const addresses = fixture.transactions
          .flatMap((t) => [...t.vin.map((i) => i.prevout?.address), ...t.vout.map((o) => o.address)])
          .filter((a): a is string => !!a);
        const query: BitcoinQuery = { fromBlock: fixture.fromBlock, toBlock: fixture.toBlock, addresses: [...new Set(addresses)] };
        const heights = fixture.transactions.map((t) => t.blockHeight);
        return expectCachedReplay(name, fixtureSource(fixture, options), (source, toBlock) => source.fetch({ ...query, toBlock }), query, heights, (batch) => batch.transactions);
      }
      case "solana": {
        const query: SolanaQuery = { fromBlock: Math.max(fixture.fromBlock, fixture.firstBlock ?? 0), toBlock: fixture.toBlock, addresses: [...new Set(fixture.balances.map(walletOf))] };
        const heights = fixture.transactions.map((t) => t.slot);
        return expectCachedReplay(name, fixtureSource(fixture, options), (source, toBlock) => source.fetch({ ...query, toBlock }), query, heights, (batch) => batch.transactions);
      }
    }
  });

  it("migrates, inserts and reads typed rows (with dedup on re-insert)", async () => {
    const at = new Date("2026-03-01T10:00:00.123Z");
    await db.insert(events).values([
      { id: "1", wallet: "0xAAA", amount: 10n, at, payload: { a: 1 } },
      { id: "2", wallet: "0xAAA", amount: -3n, at, payload: { a: 2 } },
    ], { chain: "base", block: 5, version: 1n });
    // Re-insert row 1 with a newer version: ReplacingMergeTree keeps the latest.
    await db.insert(events).values({ id: "1", wallet: "0xAAA", amount: 11n, at, payload: { a: 1 } }, { chain: "base", block: 6, version: 2n });
    const rows = await db.rows(events, sql`WHERE wallet = ${"0xaaa"} ORDER BY id`);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "1", wallet: "0xaaa", amount: 11n, flag: false, payload: { a: 1 } });
    expect(rows[0]!.at.toISOString()).toBe(at.toISOString());
    const found = await db.find(events, { wallet: "0xaaa", id: "2" });
    expect(found?.amount).toBe(-3n);
    const raw = await db.query<{ n: string }>(sql`SELECT count() AS n FROM ${events} FINAL WHERE wallet = ${"0xaaa"}`);
    expect(Number(raw[0]!.n)).toBe(2);
  });

  it("throws when a query fails after its first rows were sent, instead of returning them", async () => {
    const failing = sql`SELECT number, throwIf(number = 50000) AS failed FROM numbers(100000)`;
    await expect(db.query(failing, { settings: { max_block_size: "1000" } })).rejects.toThrow();
  });

  it("feeds materialized views", async () => {
    const rows = await db.query<{ wallet: string; amount: string }>(sql`SELECT wallet, sum(amount) AS amount FROM ${totals} GROUP BY wallet`);
    // MV saw both inserts of row 1 (10 and 11) plus -3: 18. This is why aggregates should be keyed by immutable rows.
    expect(rows).toEqual([{ wallet: "0xaaa", amount: "18" }]);
  });

  it("serves plain views computed at read time, after dedup", async () => {
    // Same rows as the materialized view above, but read through FINAL: 11 - 3, not 18.
    expect(await db.query(sql`SELECT wallet, amount FROM ${balances}`)).toEqual([{ wallet: "0xaaa", amount: "8" }]);
    expect(await db.query(sql`SELECT wallet FROM ${positive}`)).toEqual([{ wallet: "0xaaa" }]);
    await migrate(db, { positive, events, totals, totalsMv, balances }); // re-running migrate replaces the views in place
  });

  it("keeps an unchanged refreshable view across migrates, and recreates it when its query or schedule changes", async () => {
    const own = createDb(ch.database());
    const counts = table("counts", { n: t.uint64() }, { orderBy: ["n"], indexMeta: false });
    const countsMv = (query: SqlFragment, schedule: string) => materializedView("counts_mv", { from: events, to: counts, query, refresh: { schedule, append: true } });
    const positiveCount = sql`SELECT count() AS n FROM ${events} WHERE amount > ${0n}`;
    const live = () => own.query<{ uuid: string; as_select: string }>(sql`SELECT uuid, as_select FROM system.tables WHERE database = ${own.database} AND name = 'counts_mv'`);
    const refreshes = () => own.query(sql`SELECT uuid, last_success_time, next_refresh_time FROM system.view_refreshes WHERE database = ${own.database}`);

    await migrate(own, { events, counts, countsMv: countsMv(positiveCount, "EVERY 1 HOUR OFFSET 12 MINUTE") });
    await own.command(`SYSTEM WAIT VIEW \`${own.database}\`.counts_mv`);
    const [created] = await live();
    const [refreshed] = await refreshes();
    await migrate(own, { events, counts, countsMv: countsMv(positiveCount, "EVERY 1 HOUR OFFSET 12 MINUTE") });
    expect(await live()).toEqual([created]);
    expect(await refreshes()).toEqual([refreshed]);

    await migrate(own, { events, counts, countsMv: countsMv(sql`SELECT count() AS n FROM ${events}`, "EVERY 1 HOUR OFFSET 12 MINUTE") });
    const [requeried] = await live();
    expect(requeried!.uuid).not.toBe(created!.uuid);
    expect(requeried!.as_select).toBe(`SELECT count() AS n FROM ${own.database}.events`);

    await migrate(own, { events, counts, countsMv: countsMv(sql`SELECT count() AS n FROM ${events}`, "EVERY 2 HOUR") });
    const [rescheduled] = await live();
    expect(rescheduled!.uuid).not.toBe(requeried!.uuid);
    await own.close();
  });

  it("populates a view's target by column name, whatever order its query selects them in", async () => {
    const labels = table("labels", { wallet: t.address(), label: t.string(), rank: t.uint32() }, { orderBy: ["wallet"] });
    const copy = table("labels_copy", { wallet: t.address(), label: t.string(), rank: t.uint32() }, { orderBy: ["wallet"] });
    const copyMv = materializedView("labels_copy_mv", { from: labels, to: copy, query: sql`SELECT label, wallet, rank, _yail_version, _yail_block, _yail_chain FROM ${labels}` });
    const own = createDb(ch.database());
    await migrate(own, { labels });
    await own.insert(labels).values({ wallet: "0xaaa", label: "whale", rank: 1 }, { chain: "base", block: 7, version: 9n });
    await migrate(own, { labels, copy, copyMv }, { populate: true });
    expect(await own.query(sql`SELECT wallet, label, rank, _yail_chain, _yail_block, _yail_version FROM ${copy}`)).toEqual([
      { wallet: "0xaaa", label: "whale", rank: 1, _yail_chain: "base", _yail_block: "7", _yail_version: "9" },
    ]);
    await own.close();
  });

  it("drops the databases it named, views included, when stopped on a YAIL_TEST_CLICKHOUSE_URL server, and starts afresh after", async () => {
    vi.stubEnv("YAIL_TEST_CLICKHOUSE_URL", ch.url);
    vi.resetModules();
    const testing = await import("../src/testing/index.js");
    const server = await testing.startTestClickHouse();
    const scratch = createDb(server.database());
    const counts = table("counts", { n: t.uint64() }, { orderBy: ["n"], indexMeta: false });
    const countsMv = materializedView("counts_mv", { from: events, to: counts, query: sql`SELECT count() AS n FROM ${events}`, refresh: { schedule: "EVERY 1 HOUR" } });
    await migrate(scratch, { events, counts, countsMv });
    await scratch.close();
    await server.stop();
    const next = await testing.startTestClickHouse();
    expect(next).not.toBe(server);
    await next.stop();
    vi.unstubAllEnvs();
    expect(await db.query(sql`SELECT name FROM system.databases WHERE name = ${scratch.database}`)).toEqual([]);
    expect(await db.query(sql`SELECT view FROM system.view_refreshes WHERE database = ${scratch.database}`)).toEqual([]);
  });

  it("batch writer flushes per table and answers peek()", async () => {
    const w = new BatchWriter(db);
    w.add(events, { id: "9", wallet: "0xbbb", amount: 1n, at: new Date(), payload: { a: 9 } }, { chain: "base", block: 1, version: 3n });
    expect(w.peek(events, { wallet: "0xbbb", id: "9" })?.amount).toBe(1n);
    expect(w.peek(events, { wallet: "0xbbb" })).toBeNull();
    const res = await w.flush();
    expect(res).toEqual({ tables: 1, rows: 1 });
    expect((await db.find(events, { wallet: "0xbbb", id: "9" }))?.amount).toBe(1n);
  });

  it("http client caches responses in ClickHouse", async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async (url) => {
      calls++;
      return new Response(JSON.stringify({ url: String(url), n: calls }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const http = createHttpClient({ db, fetch: fakeFetch });
    const a = await http.get("https://example.com/price?ts=1", { cache: true });
    const b = await http.get("https://example.com/price?ts=1", { cache: true });
    expect(a.json()).toEqual({ url: "https://example.com/price?ts=1", n: 1 });
    expect(b.cached).toBe(true);
    expect(calls).toBe(1);
    // A fresh client (empty memory) must hit the ClickHouse cache, not the network.
    const http2 = createHttpClient({ db, fetch: fakeFetch });
    const c = await http2.get("https://example.com/price?ts=1", { cache: true });
    expect(c.cached).toBe(true);
    expect(calls).toBe(1);
    const d = await http2.get("https://example.com/price?ts=2");
    expect(d.cached).toBe(false);
    expect(calls).toBe(2);
  });

  it("computes a cached answer once per chain and key", async () => {
    let runs = 0;
    const store = memory();
    const metadata = (cache: CacheRunner, address: string) => cache.run({ key: ["tokenMetadata", address], handler: async () => ({ symbol: `T${++runs}`, address }) });
    const base = new CacheRunner(store, "base");
    const [a, b] = await Promise.all([metadata(base, "0xa"), metadata(base, "0xa")]);
    expect(a).toEqual({ symbol: "T1", address: "0xa" });
    expect(b).toEqual(a); // concurrent calls share the run
    expect(await metadata(new CacheRunner(store, "base"), "0xa")).toEqual(a); // the store, not the run
    expect(await metadata(base, "0xb")).toEqual({ symbol: "T2", address: "0xb" });
    expect(await metadata(new CacheRunner(store, "polygon"), "0xa")).toEqual({ symbol: "T3", address: "0xa" }); // per chain
    await seedCache(store, "base", ["tokenMetadata", "0xc"], { symbol: "SEED", address: "0xc" });
    expect(await metadata(base, "0xc")).toEqual({ symbol: "SEED", address: "0xc" });
    expect(runs).toBe(3);
  });
});

/** Caches every batch of `query`, then reads a shorter range: one cache hit, equal to what `inner` serves, with rows. */
async function expectCachedReplay<S extends Source, B extends RangeBatch>(chain: string, inner: S, fetch: (source: S, toBlock: number) => AsyncIterable<B>, query: RangeQuery, heights: number[], rowsOf: (batch: B) => unknown[]) {
  const events: string[] = [];
  const source = cached(inner, { db, chain, onEvent: (e) => events.push(e.type) });
  const read = async (from: S, toBlock: number) => {
    const batches: B[] = [];
    for await (const batch of fetch(from, toBlock)) batches.push(batch);
    return batches;
  };
  await read(source, query.toBlock);
  events.length = 0;
  const available = heights.filter((h) => h >= query.fromBlock);
  const end = Math.floor((Math.min(...available) + Math.max(...available)) / 2);
  const expected = await read(inner, end);
  expect(rowsOf(expected[0]!).length).toBeGreaterThan(0);
  expect(await read(source, end)).toEqual(expected);
  expect(events).toEqual(["hit"]);
}
