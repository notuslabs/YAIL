import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestClickHouse, type TestClickHouse } from "../src/testing/index.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { sql } from "../src/db/sql.js";
import { t, table, materializedView, view } from "../src/schema/index.js";
import { BatchWriter } from "../src/db/batch.js";
import { Lookups, lookup, seedLookup } from "../src/lookups/lookup.js";
import { memory } from "../src/lookups/caches.js";
import { createHttpClient } from "../src/http/client.js";

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
});

describe("clickhouse", () => {
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

  it("resolves a lookup once per chain and input, through the cache", async () => {
    let runs = 0;
    const metadata = lookup("metadata", async ({ address }: { address: string }) => ({ symbol: `T${++runs}`, decimals: 18, address }));
    const context = { chain: { name: "base", id: 8453, kind: "evm" as const }, client: undefined, http: createHttpClient({ db }) };
    const cache = memory();
    const lookups = new Lookups(cache, context);
    const [a, b] = await Promise.all([lookups.run(metadata, { address: "0xa" }), lookups.run(metadata, { address: "0xa" })]);
    expect(a).toEqual({ symbol: "T1", decimals: 18, address: "0xa" });
    expect(b).toEqual(a); // concurrent calls share the run
    expect(await new Lookups(cache, context).run(metadata, { address: "0xa" })).toEqual(a); // the cache, not the run
    expect(await lookups.run(metadata, { address: "0xb" })).toEqual({ symbol: "T2", decimals: 18, address: "0xb" });
    expect(await new Lookups(cache, { ...context, chain: { ...context.chain, name: "polygon" } }).run(metadata, { address: "0xa" })).toEqual({ symbol: "T3", decimals: 18, address: "0xa" }); // per chain
    await seedLookup(cache, "base", metadata, { address: "0xc" }, { symbol: "SEED", decimals: 6, address: "0xc" });
    expect(await lookups.run(metadata, { address: "0xc" })).toEqual({ symbol: "SEED", decimals: 6, address: "0xc" });
    expect(runs).toBe(3);
  });
});
