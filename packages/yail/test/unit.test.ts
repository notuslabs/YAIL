import { describe, expect, it, vi } from "vitest";
import { decodeEventLog, encodeAbiParameters, parseAbi, toEventSelector, type AbiEvent, type Hex } from "viem";
import { t, table, materializedView, tableDdl, materializedViewDdl, materializedViewPopulateSql, view, viewDdl } from "../src/schema/index.js";
import { sql, renderSql } from "../src/db/sql.js";
import { serializeRow, deserializeRow } from "../src/db/serialize.js";
import { createConfig, addressSet, factory } from "../src/config/index.js";
import { buildPlans, buildEvmQuery, nextBoundary } from "../src/indexer/plan.js";
import { AddressRegistry } from "../src/addresses/registry.js";
import { compileFilter, decodeLog, logMatchesFilter, padAddress } from "../src/indexer/events.js";
import { fixtureSource, matchesLogFilters } from "../src/sources/fixture.js";
import { hashQuery } from "../src/sources/cached.js";
import { matchEvmBatch, wholeBlocksQuery } from "../src/sources/match.js";
import type { EvmBatch, EvmQuery } from "../src/sources/types.js";
import { FixtureBuilder, addr } from "./helpers.js";
import { append } from "../src/util.js";
import type { Db } from "../src/db/client.js";
import { CacheRunner } from "../src/cache/cached.js";
import { memory } from "../src/cache/stores.js";

const erc20 = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)", "event Approval(address indexed owner, address indexed spender, uint256 value)"]);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ledger = table(
  "ledger",
  {
    chain: t.string().lowCardinality(),
    wallet: t.address(),
    txHash: t.hash(),
    logIndex: t.uint32(),
    amount: t.int256(),
    blockTime: t.dateTime(),
    note: t.string().nullable(),
    tags: t.array(t.string()).default("[]"),
  },
  { orderBy: ["wallet", "chain", "txHash", "logIndex"], partitionBy: "toYYYYMM(block_time)", scopes: { wallet: "wallet" } },
);

describe("cache failures", () => {
  it.each(["sync", "async"])("allows a retry after a %s handler failure", async (mode) => {
    const cache = new CacheRunner(memory(), "base");
    const error = new Error("lookup failed");
    const handler = vi.fn(() => {
      if (mode === "sync") throw error;
      return Promise.reject(error);
    });
    const results = await Promise.allSettled([
      cache.run({ key: "token", handler }),
      cache.run({ key: "token", handler }),
    ]);
    expect(results).toEqual([
      { status: "rejected", reason: error },
      { status: "rejected", reason: error },
    ]);
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(cache.run({ key: "token", handler: async () => "USDC" })).resolves.toBe("USDC");
  });

  it("allows a retry when the store fails to save an answer", async () => {
    const store = memory();
    vi.spyOn(store, "set").mockRejectedValueOnce(new Error("store unavailable"));
    const cache = new CacheRunner(store, "base");
    const handler = vi.fn(async () => "USDC");
    await expect(cache.run({ key: "token", handler })).rejects.toThrow("store unavailable");
    await expect(cache.run({ key: "token", handler })).resolves.toBe("USDC");
    await expect(cache.run({ key: "token", handler })).resolves.toBe("USDC");
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe("schema", () => {
  it("renders DDL with meta columns and Replacing engine", () => {
    const ddl = tableDdl(ledger, "db");
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS `db`.`ledger`");
    expect(ddl).toContain("`wallet` String");
    expect(ddl).toContain("`chain` LowCardinality(String)");
    expect(ddl).toContain("`note` Nullable(String)");
    expect(ddl).toContain("`tags` Array(String) DEFAULT []");
    expect(ddl).toContain("`_yail_version` UInt64");
    expect(ddl).toContain("ENGINE = ReplacingMergeTree(_yail_version)");
    expect(ddl).toContain("PARTITION BY toYYYYMM(block_time)");
    expect(ddl).toContain("ORDER BY (`wallet`, `chain`, `tx_hash`, `log_index`)");
  });

  it("renders materialized views with inlined SQL", () => {
    const daily = table("daily", { wallet: t.address(), day: t.date(), amount: t.int256() }, { orderBy: ["wallet", "day"], engine: "SummingMergeTree", indexMeta: false });
    const mv = materializedView("ledger_daily_mv", { from: ledger, to: daily, query: sql`SELECT wallet, toDate(block_time) AS day, sum(amount) AS amount FROM ${ledger} GROUP BY wallet, day` });
    const ddl = materializedViewDdl(mv, "db");
    expect(ddl).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS `db`.`ledger_daily_mv` TO `db`.`daily` AS");
    expect(ddl).toContain("FROM `db`.`ledger`");
    expect(tableDdl(daily)).toContain("ENGINE = SummingMergeTree()");
  });

  it("populates a view's target by column name", () => {
    const daily = table("daily", { wallet: t.address(), day: t.date(), amount: t.int256() }, { orderBy: ["wallet", "day"], indexMeta: false });
    const mv = materializedView("ledger_daily_mv", { from: ledger, to: daily, query: sql`SELECT toDate(block_time) AS day, wallet, sum(amount) AS amount FROM ${ledger} GROUP BY wallet, day` });
    expect(materializedViewPopulateSql(mv, "db")).toBe(
      "INSERT INTO `db`.`daily` (`wallet`, `day`, `amount`)\nSELECT `wallet`, `day`, `amount`\nFROM (\nSELECT toDate(block_time) AS day, wallet, sum(amount) AS amount FROM `db`.`ledger` GROUP BY wallet, day\n)",
    );
    const copy = materializedView("ledger_copy_mv", { from: ledger, to: ledger, query: sql`SELECT * FROM ${ledger}` });
    expect(materializedViewPopulateSql(copy)).toContain("(`chain`, `wallet`, `tx_hash`, `log_index`, `amount`, `block_time`, `note`, `tags`, `_yail_chain`, `_yail_block`, `_yail_version`)");
  });

  it("renders plain views that read tables and earlier views", () => {
    const balances = view("balances", sql`SELECT wallet, sum(amount) AS balance FROM ${ledger} FINAL GROUP BY wallet`);
    const rich = view("rich", sql`SELECT * FROM ${balances} WHERE balance > ${1000n}`);
    expect(viewDdl(balances, "db")).toContain("CREATE OR REPLACE VIEW `db`.`balances` AS\nSELECT wallet, sum(amount) AS balance FROM `db`.`ledger` FINAL");
    expect(viewDdl(rich, "db")).toContain("FROM `db`.`balances` WHERE balance > 1000");
  });

  it("serializes and deserializes rows", () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    const row = serializeRow(ledger, { chain: "base", wallet: "0xABC", txHash: "0x1", logIndex: 3, amount: -5n, blockTime: now, note: null }, { chain: "base", block: 10, version: 7n });
    expect(row).toEqual({ chain: "base", wallet: "0xabc", tx_hash: "0x1", log_index: 3, amount: "-5", block_time: Math.floor(now.getTime() / 1000), note: null, _yail_chain: "base", _yail_block: 10, _yail_version: "7" });
    const back = deserializeRow(ledger, { chain: "base", wallet: "0xabc", tx_hash: "0x1", log_index: "3", amount: "-5", block_time: "2026-01-02T03:04:05Z", note: null, tags: ["a"] });
    expect(back).toEqual({ chain: "base", wallet: "0xabc", txHash: "0x1", logIndex: 3, amount: -5n, blockTime: now, note: null, tags: ["a"] });
    expect(() => serializeRow(ledger, { chain: "base" } as any)).toThrow(/missing required column "wallet"/);
  });
});

describe("append", () => {
  it("appends more items than a spread call can pass as arguments", () => {
    const items = Array.from({ length: 300_000 }, (_, i) => i);
    expect(() => [].push(...(items as never[]))).toThrow(RangeError);
    const target = [-1];
    append(target, items);
    expect([target.length, target.at(-1)]).toEqual([300_001, 299_999]);
  });
});

describe("sql", () => {
  it("parameterizes values and inlines tables", () => {
    const q = sql`SELECT * FROM ${ledger} WHERE wallet = ${"0xabc"} AND amount > ${5n} AND log_index IN ${[1, 2]} AND ok = ${true}`;
    const { text, params } = renderSql(q);
    expect(text).toBe("SELECT * FROM `ledger` WHERE wallet = {p0:String} AND amount > {p1:Int256} AND log_index IN {p2:Array(Int64)} AND ok = {p3:Bool}");
    expect(params).toEqual({ p0: "0xabc", p1: "5", p2: [1, 2], p3: true });
  });
  it("joins fragments and inlines literals", () => {
    const conds = [sql`a = ${1}`, sql`b = ${"x'y"}`];
    const { text } = renderSql(sql`WHERE ${sql.join(conds, " AND ")}`, { inline: true });
    expect(text).toBe("WHERE a = 1 AND b = 'x\\'y'");
  });
});

describe("plan", () => {
  const config = createConfig({
    database: { url: "http://localhost:8123" },
    chains: {
      base: { id: 8453, source: fixtureSource({ version: 1, kind: "evm", height: 100, fromBlock: 0, toBlock: 100, blocks: [], transactions: [], logs: [] }) },
    },
    contracts: {
      Erc20: { abi: erc20, chain: "base", startBlock: 10, filter: [{ event: "Transfer", args: { from: addressSet("wallets") } }, { event: "Transfer", args: { to: addressSet("wallets") } }] },
      Usdc: { abi: erc20, chain: "base", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", startBlock: 50, endBlock: 80 },
      Pool: { abi: erc20, chain: "base", address: factory({ address: "0x1F98431c8aD98523631AE4a59f267346ea31F984", event: parseAbi(["event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"])[0], parameter: "pool" }) },
    },
    accounts: { Wallets: { chain: "base", address: addressSet("wallets"), startBlock: 20 } },
  });

  const fakeDb = { rows: async () => [], insert: () => ({ values: async () => {} }) } as unknown as Db;

  it("only fetches handled events and resolves address sets", async () => {
    const registry = new AddressRegistry(fakeDb, (_c, a) => a.toLowerCase());
    await registry.register({ set: "wallets", chain: "base", address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", status: "live", adoptedAtBlock: 1 });
    const plans = buildPlans(config, { handled: new Set(["Erc20:Transfer", "Wallets:transaction", "Pool:Transfer"]), resolveLatest: () => 100 });
    const plan = plans.get("base")!;
    expect(plan.startBlock).toBe(0); // Pool has no startBlock
    expect(plan.contracts.map((c) => c.name)).toEqual(["Erc20", "Pool"]); // Usdc has no handlers
    expect(nextBoundary(plan, 0)).toBe(10);
    const q = buildEvmQuery(plan, 0, 100, registry);
    const padded = padAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(q.logs).toContainEqual({ address: undefined, topics: [[TRANSFER], [padded]] });
    expect(q.logs).toContainEqual({ address: undefined, topics: [[TRANSFER], null, [padded]] });
    // factory creation event is fetched from the factory address
    expect(q.logs.some((l) => l.address?.[0] === "0x1f98431c8ad98523631ae4a59f267346ea31f984")).toBe(true);
    expect(q.transactions).toEqual([{ from: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] }, { to: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] }]);
    expect(q.includeLogTransactions).toBe(false);
  });

  it("builds override queries for address backfills", () => {
    const registry = new AddressRegistry(fakeDb, (_c, a) => a.toLowerCase());
    const plans = buildPlans(config, { handled: new Set(["Erc20:Transfer", "Wallets:transaction", "Pool:Transfer"]), resolveLatest: () => 100 });
    const q = buildEvmQuery(plans.get("base")!, 0, 100, registry, { override: { set: "wallets", addresses: ["0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"] } });
    expect(q.logs.every((l) => l.topics?.[0]?.[0] === TRANSFER)).toBe(true);
    expect(q.logs.some((l) => l.address !== undefined)).toBe(false); // no factory fetch in override mode
    expect(q.transactions).toEqual([{ from: ["0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"] }, { to: ["0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"] }]);
  });

  it("matches activity accounts through log topics and traces, and asks for whole transactions", async () => {
    const registry = new AddressRegistry(fakeDb, (_c, a) => a.toLowerCase());
    await registry.register({ set: "wallets", chain: "base", address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", status: "live", adoptedAtBlock: 1 });
    const activity = createConfig({ ...config, accounts: { Wallets: { chain: "base", address: addressSet("wallets"), activity: true } } });
    const plan = buildPlans(activity, { handled: new Set(["Wallets:transaction"]), resolveLatest: () => 100 }).get("base")!;
    const q = buildEvmQuery(plan, 0, 100, registry);
    const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const padded = padAddress(wallet);
    expect(q.logs).toEqual([{ topics: [null, [padded]], join: true }, { topics: [null, null, [padded]], join: true }, { topics: [null, null, null, [padded]], join: true }]);
    expect(q.traces).toEqual([{ from: [wallet] }, { to: [wallet] }]);
    expect(q.join).toBe(true);
  });

  it("answers live addresses from memory until a row of the chain changes", async () => {
    const [a, b] = ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"];
    let stored: unknown[] = [];
    const db = { rows: async () => stored, insert: () => ({ values: async (rows: unknown[]) => void (stored = rows) }) } as unknown as Db;
    const registry = new AddressRegistry(db, (_c, x) => x.toLowerCase());
    await registry.register({ set: "wallets", chain: "base", address: a, status: "live", adoptedAtBlock: 1 });
    const live = registry.live("wallets", "base");
    await registry.load();
    await registry.register({ set: "wallets", chain: "polygon", address: b, status: "live", adoptedAtBlock: 1 });
    expect(registry.live("wallets", "base")).toBe(live);
    await registry.register({ set: "wallets", chain: "base", address: b, status: "live", adoptedAtBlock: 1 });
    expect(registry.live("wallets", "base")).toEqual([a, b]);
  });

  it("skips empty address sets instead of matching everything", () => {
    const registry = new AddressRegistry(fakeDb, (_c, a) => a.toLowerCase());
    const plans = buildPlans(config, { handled: new Set(["Erc20:Transfer"]), resolveLatest: () => 100 });
    const q = buildEvmQuery(plans.get("base")!, 0, 100, registry);
    expect(q.logs).toEqual([]);
  });

  it("compiles and matches filters", () => {
    const f = compileFilter(erc20, { event: "Transfer", args: { to: addressSet("wallets"), from: "0x1111111111111111111111111111111111111111" } });
    expect(f.topics).toEqual([{ index: 2, set: "wallets" }, { index: 1, values: [padAddress("0x1111111111111111111111111111111111111111")] }]);
    const log = { blockNumber: 1, transactionHash: "0x", transactionIndex: 0, logIndex: 0, address: "0x", data: "0x", topics: [TRANSFER, padAddress("0x1111111111111111111111111111111111111111"), padAddress("0x2222222222222222222222222222222222222222")] };
    expect(logMatchesFilter(log, f, (_s, a) => a === "0x2222222222222222222222222222222222222222")).toBe(true);
    expect(logMatchesFilter(log, f, () => false)).toBe(false);
    expect(matchesLogFilters(log, { fromBlock: 0, toBlock: 2, logs: [{ topics: [[TRANSFER], null, [padAddress("0x2222222222222222222222222222222222222222")]] }], transactions: [] })).toBe(true);
  });

  it("right-pads bytesN filter values to a whole topic", () => {
    const abi = parseAbi(["event Tagged(bytes4 indexed tag, bytes32 indexed id)"]);
    const id = `0x${"ab".repeat(32)}`;
    const f = compileFilter(abi, { event: "Tagged", args: { tag: "0xDEADBEEF", id } });
    expect(f.topics).toEqual([
      { index: 1, values: [`0xdeadbeef${"0".repeat(56)}`] },
      { index: 2, values: [id] },
    ]);
  });

  it("hashes queries independent of range", () => {
    const a = hashQuery({ fromBlock: 1, toBlock: 2, logs: [{ address: ["0xAB"] }], transactions: [] } as any);
    const b = hashQuery({ fromBlock: 5, toBlock: 9, logs: [{ address: ["0xab"] }], transactions: [] } as any);
    const c = hashQuery({ fromBlock: 5, toBlock: 9, logs: [{ address: ["0xcd"] }], transactions: [] } as any);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("decodeLog", () => {
  const events = parseAbi([
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "event Unnamed(address indexed, uint256, bool indexed)",
    "event Mixed(string indexed label, bytes32 indexed id, uint256[] amounts, (address who, uint128 amount) entry)",
    "event Empty()",
  ]);
  const word = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);
  const who = padAddress(addr(0x42));
  const logOf = (event: AbiEvent, topics: string[], data: string) => ({ blockNumber: 1, transactionHash: "0x01", transactionIndex: 0, logIndex: 0, address: addr(0x1), data, topics: [toEventSelector(event), ...topics] });
  const viem = (event: AbiEvent, log: { topics: string[]; data: string }) => {
    try {
      return { args: decodeEventLog({ abi: [event], data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], strict: false }).args ?? {} };
    } catch {
      return null;
    }
  };
  const [transfer, unnamed, mixed, empty] = events;
  const cases = [
    logOf(transfer, [who, who], word(7n)),
    logOf(transfer, [who], encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [addr(0x43) as Hex, 9n])),
    logOf(transfer, [who, who], "0x"),
    logOf(transfer, [who, who], "0x1234"),
    logOf(unnamed, [who, word(1n)], word(5n)),
    logOf(unnamed, [who], encodeAbiParameters([{ type: "bool" }, { type: "uint256" }], [true, 5n])),
    logOf(mixed, [word(1n), word(2n)], encodeAbiParameters([{ type: "uint256[]" }, { type: "tuple", components: [{ name: "who", type: "address" }, { name: "amount", type: "uint128" }] }], [[1n, 2n], { who: addr(0x44) as Hex, amount: 3n }])),
    logOf(empty, [], "0x"),
    { ...logOf(transfer, [who, who], word(7n)), topics: [toEventSelector(unnamed), who, who] },
    { ...logOf(transfer, [who, who], word(7n)), topics: [] },
  ];

  it.each(cases.map((log, i) => [i, log] as const))("decodes case %i the way viem's decodeEventLog does", (_, log) => {
    const event = events.find((e) => toEventSelector(e) === log.topics[0]) ?? transfer;
    expect(decodeLog(event, log)).toEqual(viem(event, log));
  });
});

describe("whole blocks", () => {
  const TOKEN = addr(0x100);
  const DEX = addr(0x700);
  const W = addr(0x1);
  const OTHER = addr(0x9);
  const query: EvmQuery = {
    fromBlock: 0,
    toBlock: 11,
    logs: [{ address: [DEX], topics: [[TRANSFER]] }, { topics: [null, null, [padAddress(W)]], join: true }],
    transactions: [{ from: [W] }, { to: [W] }],
    traces: [{ from: [W] }, { to: [W] }],
    join: true,
  };

  function blocks() {
    const fb = new FixtureBuilder(10);
    const toWallet = fb.tx(2, OTHER, DEX, 0n);
    const received = fb.transfer(2, TOKEN, OTHER, W, 5n, toWallet);
    const swapOfWallet = fb.transfer(2, DEX, OTHER, OTHER, 1n, toWallet);
    const swap = fb.transfer(3, DEX, OTHER, OTHER, 2n);
    fb.transfer(4, TOKEN, OTHER, OTHER, 3n);
    const internal = fb.tx(5, OTHER, DEX, 0n);
    const calls = [fb.trace(internal, OTHER, DEX, 0n, []), fb.trace(internal, DEX, W, 7n, [0])];
    const fx = fb.build();
    const batch: EvmBatch = { fromBlock: 0, nextBlock: 11, blocks: fx.blocks, transactions: fx.transactions, logs: fx.logs, traces: fx.traces };
    return { batch, toWallet, received, swapOfWallet, swap, internal, calls };
  }

  it("asks for every log, transaction and trace of the range, without filters", () => {
    expect(wholeBlocksQuery(query)).toEqual({ fromBlock: 0, toBlock: 11, logs: [{}], transactions: [{}], traces: [{}] });
    expect(wholeBlocksQuery({ fromBlock: 0, toBlock: 11, logs: [{ address: [DEX] }], transactions: [] })).toEqual({ fromBlock: 0, toBlock: 11, logs: [{}], transactions: [], traces: [] });
  });

  it("selects what the filtered query returns: joined transactions whole, plain logs alone, each item once", () => {
    const { batch, toWallet, received, swapOfWallet, swap, internal, calls } = blocks();
    const matched = matchEvmBatch(batch, query);
    expect(matched.transactions.map((t) => t.hash)).toEqual([toWallet.hash, internal.hash]);
    expect(matched.logs).toEqual([received, swapOfWallet, swap]);
    expect(matched.traces).toEqual(calls);
    expect(matched.blocks.map((b) => b.number)).toEqual([2, 3, 5]);
  });

  it("adds the transactions of plain logs with includeLogTransactions", () => {
    const { batch, swap } = blocks();
    const matched = matchEvmBatch(batch, { ...query, includeLogTransactions: true });
    expect(matched.transactions.map((t) => t.hash)).toContain(swap.transactionHash);
  });

  it("matches logs on any filter without join", () => {
    const { batch, received, swapOfWallet, swap } = blocks();
    const matched = matchEvmBatch(batch, { ...query, transactions: [], traces: [], join: false });
    expect(matched.logs).toEqual([received, swapOfWallet, swap]);
    expect(matched.transactions).toEqual([]);
  });
});

describe("config validation", () => {
  it("rejects unknown chains and non-indexed filter args", () => {
    const src = fixtureSource({ version: 1, kind: "evm", height: 1, fromBlock: 0, toBlock: 1, blocks: [], transactions: [], logs: [] });
    expect(() => createConfig({ database: { url: "http://x" }, chains: { base: { id: 1, source: src } }, contracts: { A: { abi: erc20, chain: "nope" } } })).toThrow(/unknown chain "nope"/);
    expect(() => createConfig({ database: { url: "http://x" }, chains: { base: { id: 1, source: src } }, contracts: { A: { abi: erc20, chain: "base", filter: { event: "Transfer", args: { value: 1 } } } } })).toThrow(/must be indexed/);
  });

  it("rejects a backfillSource of another kind than source", () => {
    const evm = fixtureSource({ version: 1, kind: "evm", height: 1, fromBlock: 0, toBlock: 1, blocks: [], transactions: [], logs: [] });
    const solana = fixtureSource({ version: 1, kind: "solana", height: 1, fromBlock: 0, toBlock: 1, blocks: [], transactions: [], balances: [] });
    expect(() => createConfig({ database: { url: "http://x" }, chains: { base: { id: 1, source: evm, backfillSource: solana } } })).toThrow(/backfillSource .* is a solana source, source .* is evm/);
    expect(() => createConfig({ database: { url: "http://x" }, chains: { base: { id: 1, source: evm, backfillSource: evm } } })).not.toThrow();
  });
});
