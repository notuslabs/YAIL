/**
 * Replays real on-chain data recorded in test/fixtures (see scripts/record-fixtures.ts)
 * and checks the indexed result against ground truth read from the chain at
 * record time. If a handler is wrong, these numbers stop matching.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAbi } from "viem";
import { startTestClickHouse, readFixture, fixtureSource, type TestClickHouse, type EvmFixture, type BitcoinFixture } from "../src/testing/index.js";
import { createConfig, addressSet } from "../src/config/index.js";
import { createIndexer } from "../src/indexer/indexer.js";
import type { HandlerContext } from "../src/indexer/context.js";
import { t, table } from "../src/schema/index.js";
import { sql } from "../src/db/sql.js";
import type { Db } from "../src/db/client.js";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;
let ch: TestClickHouse;
beforeAll(async () => {
  ch = await startTestClickHouse();
});

describe("Uniswap V3 pool on Base (WETH/USDC 0.05%)", () => {
  const fixture = readFixture<EvmFixture>(`${fixtures}base-univ3-weth-usdc.json`);
  const expected = fixture.expected as { pool: string; endBlock: number; sqrtPriceX96: bigint; tick: number; liquidity: bigint; startSqrtPriceX96: bigint; startTick: number; startLiquidity: bigint };
  const poolAbi = parseAbi([
    "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
    "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
    "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  ]);
  const poolState = table("pool_state", { pool: t.address(), sqrtPriceX96: t.uint256(), tick: t.int32(), liquidity: t.uint256(), block: t.uint64() }, { orderBy: ["pool"] });
  const swaps = table(
    "swaps",
    { pool: t.address(), txHash: t.hash(), logIndex: t.uint32(), block: t.uint64(), blockTime: t.dateTime(), amount0: t.int256(), amount1: t.int256(), sqrtPriceX96: t.uint256(), liquidity: t.uint256(), tick: t.int32() },
    { orderBy: ["pool", "block", "txHash", "logIndex"], scopes: { pool: "pool" } },
  );
  let db: Db | undefined;
  afterAll(async () => {
    await db?.close();
  });

  it("tracks price and liquidity exactly as slot0()/liquidity() report on-chain", async () => {
    const config = createConfig({
      database: ch.database(),
      chains: { base: { id: 8453, source: fixtureSource(fixture, { blocksPerBatch: 40 }), finality: 0 } },
      contracts: { Pool: { abi: poolAbi, chain: "base", address: expected.pool, startBlock: fixture.fromBlock, endBlock: fixture.toBlock - 1 } },
      server: { port: false },
      observability: { pretty: false },
    });
    const indexer = createIndexer({ config, schema: { poolState, swaps } });
    indexer.on("setup", async ({ context }) => {
      // Seed state at the block before the fixture starts (from the recorded ground truth).
      context.db.insert(poolState).values({ pool: expected.pool, sqrtPriceX96: expected.startSqrtPriceX96, tick: expected.startTick, liquidity: expected.startLiquidity, block: BigInt(fixture.fromBlock - 1) });
    });
    indexer.on("Pool:Swap", async ({ event, context }) => {
      context.db.insert(swaps).values({ pool: event.address, txHash: event.log.transactionHash, logIndex: event.log.logIndex, block: BigInt(event.block.number), blockTime: new Date(event.block.timestamp * 1000), amount0: event.args.amount0, amount1: event.args.amount1, sqrtPriceX96: event.args.sqrtPriceX96, liquidity: event.args.liquidity, tick: event.args.tick });
      context.db.insert(poolState).values({ pool: event.address, sqrtPriceX96: event.args.sqrtPriceX96, tick: event.args.tick, liquidity: event.args.liquidity, block: BigInt(event.block.number) });
    });
    const applyLiquidity = async (ctx: HandlerContext, pool: string, lower: number, upper: number, delta: bigint, block: number) => {
      const state = await ctx.db.find(poolState, { pool });
      if (!state) throw new Error("state missing");
      if (state.tick >= lower && state.tick < upper) {
        ctx.db.insert(poolState).values({ ...state, liquidity: state.liquidity + delta, block: BigInt(block) });
      }
    };
    indexer.on("Pool:Mint", async ({ event, context }) => applyLiquidity(context, event.address, event.args.tickLower, event.args.tickUpper, event.args.amount, event.block.number));
    indexer.on("Pool:Burn", async ({ event, context }) => applyLiquidity(context, event.address, event.args.tickLower, event.args.tickUpper, -event.args.amount, event.block.number));
    await indexer.run();
    db = indexer.db;

    const state = await indexer.db.find(poolState, { pool: expected.pool });
    expect(state).not.toBeNull();
    expect(state!.sqrtPriceX96).toBe(expected.sqrtPriceX96);
    expect(state!.tick).toBe(expected.tick);
    expect(state!.liquidity).toBe(expected.liquidity);
    const swapRows = await indexer.db.rows(swaps, sql`ORDER BY block, log_index`);
    expect(swapRows.length).toBe(fixture.logs.filter((l) => l.topics[0]!.startsWith("0xc42079f9")).length);
    expect(swapRows.at(-1)!.sqrtPriceX96 <= expected.sqrtPriceX96 || swapRows.at(-1)!.sqrtPriceX96 >= expected.sqrtPriceX96).toBe(true);
    const status = await indexer.status();
    expect(status.chains.base!.eventsProcessed).toBe(fixture.logs.length);
  });
});

describe("USDC wallets on Base", () => {
  const fixture = readFixture<EvmFixture>(`${fixtures}base-usdc-wallets.json`);
  const expected = fixture.expected as { token: string; wallets: string[]; balances: Record<string, { start: bigint; end: bigint }>; fromBlock: number; toBlock: number };
  const erc20 = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
  const ledger = table(
    "ledger",
    { chain: t.string().lowCardinality(), wallet: t.address(), asset: t.address(), txHash: t.hash(), logIndex: t.int32(), delta: t.int256(), counterparty: t.address(), block: t.uint64(), blockTime: t.dateTime() },
    { orderBy: ["wallet", "chain", "asset", "txHash", "logIndex"], scopes: { wallet: "wallet" } },
  );
  let db: Db | undefined;
  afterAll(async () => {
    await db?.close();
  });

  it("reconstructs each wallet's USDC balance change from Transfer events", async () => {
    const config = createConfig({
      database: ch.database(),
      chains: { base: { id: 8453, source: fixtureSource(fixture, { blocksPerBatch: 20 }), finality: 0 } },
      addressSets: { wallets: { initial: expected.wallets } },
      contracts: {
        Usdc: { abi: erc20, chain: "base", address: expected.token, startBlock: fixture.fromBlock, endBlock: fixture.toBlock - 1, filter: [{ event: "Transfer", args: { from: addressSet("wallets") } }, { event: "Transfer", args: { to: addressSet("wallets") } }], includeTransactions: true },
      },
      accounts: { Wallets: { chain: "base", address: addressSet("wallets"), startBlock: fixture.fromBlock, endBlock: fixture.toBlock - 1 } },
      server: { port: false },
      observability: { pretty: false },
    });
    const indexer = createIndexer({ config, schema: { ledger } });
    indexer.on("Usdc:Transfer", async ({ event, context }) => {
      expect(event.transaction?.hash).toBe(event.log.transactionHash); // includeTransactions
      const base = { chain: context.chain.name, asset: event.address, txHash: event.log.transactionHash, logIndex: event.log.logIndex, block: BigInt(event.block.number), blockTime: new Date(event.block.timestamp * 1000) };
      if (context.addresses.has("wallets", event.args.from)) context.db.insert(ledger).values({ ...base, wallet: event.args.from, delta: -event.args.value, counterparty: event.args.to });
      if (context.addresses.has("wallets", event.args.to)) context.db.insert(ledger).values({ ...base, wallet: event.args.to, delta: event.args.value, counterparty: event.args.from });
    });
    const nativeSeen: string[] = [];
    indexer.on("Wallets:transaction", async ({ event, context }) => {
      nativeSeen.push(`${event.address}:${event.direction}`);
      const tx = event.transaction;
      let delta = -tx.value;
      let counterparty = tx.to ?? "";
      if (event.direction === "to") {
        delta = tx.value;
        counterparty = tx.from;
      }
      context.db.insert(ledger).values({ chain: context.chain.name, wallet: event.address, asset: "native", txHash: tx.hash, logIndex: -1, delta, counterparty, block: BigInt(event.block.number), blockTime: new Date(event.block.timestamp * 1000) });
    });
    await indexer.run();
    db = indexer.db;

    const rows = await indexer.db.query<{ wallet: string; delta: string; n: string }>(sql`SELECT wallet, sum(delta) AS delta, count() AS n FROM ${ledger} FINAL WHERE asset = ${expected.token} GROUP BY wallet`);
    const byWallet = Object.fromEntries(rows.map((r) => [r.wallet, BigInt(r.delta)]));
    for (const w of expected.wallets) {
      const { start, end } = expected.balances[w]!;
      expect(byWallet[w] ?? 0n, `wallet ${w}`).toBe(end - start);
    }
    // Native transactions from/to wallets were dispatched once per (tx, wallet, direction).
    const expectedNative = fixture.transactions.flatMap((tx) => {
      const out: string[] = [];
      let direction = "from";
      if (tx.to === tx.from) direction = "self";
      if (expected.wallets.includes(tx.from)) out.push(`${tx.from}:${direction}`);
      if (tx.to && expected.wallets.includes(tx.to) && tx.to !== tx.from) out.push(`${tx.to}:to`);
      return out;
    });
    expect(nativeSeen.sort()).toEqual(expectedNative.sort());
  });
});

describe("Bitcoin wallets via Esplora", () => {
  const fixture = readFixture<BitcoinFixture>(`${fixtures}bitcoin-wallets.json`);
  const expected = fixture.expected as { addresses: string[]; stats: Record<string, { txCount: number; balance: bigint; funded: bigint; spent: bigint }>; tip: number };
  const btcLedger = table("btc_ledger", { wallet: t.string(), txid: t.hash(), received: t.uint64(), sent: t.uint64(), fee: t.uint64(), block: t.uint64(), blockTime: t.dateTime() }, { orderBy: ["wallet", "txid"], scopes: { wallet: "wallet" } });
  let db: Db | undefined;
  afterAll(async () => {
    await db?.close();
  });

  it("reproduces funded/spent totals per address", async () => {
    const config = createConfig({
      database: ch.database(),
      chains: { bitcoin: { id: "bitcoin", source: fixtureSource(fixture), finality: 0 } },
      addressSets: { btc: { initial: expected.addresses } },
      accounts: { BtcWallets: { chain: "bitcoin", address: addressSet("btc"), startBlock: 0 } },
      server: { port: false },
      observability: { pretty: false },
    });
    const indexer = createIndexer({ config, schema: { btcLedger } });
    indexer.on("BtcWallets:transaction", async ({ event, context }) => {
      expect(context.chain.kind).toBe("bitcoin");
      context.db.insert(btcLedger).values({ wallet: event.address, txid: event.tx.txid, received: event.received, sent: event.sent, fee: event.fee, block: BigInt(event.block.height), blockTime: new Date(event.block.time * 1000) });
    });
    await indexer.run();
    db = indexer.db;
    const rows = await indexer.db.query<{ wallet: string; received: string; sent: string; n: string }>(sql`SELECT wallet, sum(received) AS received, sum(sent) AS sent, count() AS n FROM ${btcLedger} FINAL GROUP BY wallet`);
    expect(rows.length).toBe(expected.addresses.length);
    for (const r of rows) {
      const s = expected.stats[r.wallet]!;
      expect(BigInt(r.received), `${r.wallet} received`).toBe(s.funded);
      expect(BigInt(r.sent), `${r.wallet} sent`).toBe(s.spent);
      expect(BigInt(r.received) - BigInt(r.sent)).toBe(s.balance);
      expect(Number(r.n)).toBe(s.txCount);
    }
  });
});
