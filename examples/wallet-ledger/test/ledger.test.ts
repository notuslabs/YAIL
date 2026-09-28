import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addressSet, createConfig, sql } from "yail";
import { fixtureSource, readFixture, startTestClickHouse, type BitcoinFixture, type EvmFixture, type TestClickHouse } from "yail/testing";
import { erc20Abi } from "../src/abis.js";
import { createLedgerIndexer } from "../src/indexer.js";
import { balanceSeries, balances, flowsInPeriod } from "../src/queries.js";
import { ledgerEntries, walletDailyFlows } from "../src/schema.js";

const fixtures = new URL("../../../packages/yail/test/fixtures/", import.meta.url).pathname;
const usdc = readFixture<EvmFixture>(`${fixtures}base-usdc-wallets.json`);
const btc = readFixture<BitcoinFixture>(`${fixtures}bitcoin-wallets.json`);
const usdcExpected = usdc.expected as { token: string; wallets: string[]; balances: Record<string, { start: bigint; end: bigint }> };
const btcExpected = btc.expected as { addresses: string[]; stats: Record<string, { txCount: number; balance: bigint; funded: bigint; spent: bigint }> };

let ch: TestClickHouse;
let indexer: ReturnType<typeof createLedgerIndexer>;
const priceCalls: string[] = [];

beforeAll(async () => {
  ch = await startTestClickHouse();
  const config = createConfig({
    database: ch.database(),
    chains: {
      base: { id: 8453, source: fixtureSource(usdc, { blocksPerBatch: 25 }), finality: 0 },
      bitcoin: { id: "bitcoin", source: fixtureSource(btc), finality: 0 },
    },
    addressSets: { wallets: { initial: usdcExpected.wallets }, btcWallets: { initial: btcExpected.addresses } },
    contracts: {
      Erc20: { abi: erc20Abi, chain: "base", startBlock: usdc.fromBlock, endBlock: usdc.toBlock - 1, filter: [{ event: "Transfer", args: { from: addressSet("wallets") } }, { event: "Transfer", args: { to: addressSet("wallets") } }] },
    },
    accounts: {
      Wallets: { chain: "base", address: addressSet("wallets"), startBlock: usdc.fromBlock, endBlock: usdc.toBlock - 1 },
      BtcWallets: { chain: "bitcoin", address: addressSet("btcWallets"), startBlock: 0 },
    },
    server: { port: false },
    observability: { pretty: false, serviceName: "wallet-ledger-test" },
  });
  indexer = createLedgerIndexer(config, {
    // Deterministic price stub: 1 USD for USDC, 3000 for ETH, 60000 for BTC.
    priceAt: async (_ctx, chain, asset) => {
      priceCalls.push(`${chain}:${asset}`);
      return asset === "btc" ? 60_000 : asset === "native" ? 3_000 : 1;
    },
  });
  await indexer.run();
});
afterAll(async () => {
  await indexer?.db.close();
});

describe("wallet ledger", () => {
  it("USDC ledger deltas equal on-chain balance changes for every wallet", async () => {
    const rows = await balances(indexer.db, usdcExpected.wallets[0]!);
    expect(rows.find((r) => r.asset === usdcExpected.token)).toBeDefined();
    for (const w of usdcExpected.wallets) {
      const b = (await balances(indexer.db, w)).find((r) => r.asset === usdcExpected.token)?.balance ?? 0n;
      const { start, end } = usdcExpected.balances[w]!;
      expect(b, `wallet ${w}`).toBe(end - start);
    }
  });

  it("records native transfers and gas fees for wallet-sent transactions", async () => {
    const fees = await indexer.db.rows(ledgerEntries, sql`WHERE kind = 'fee' AND chain = 'base'`);
    const sentTxs = usdc.transactions.filter((t) => usdcExpected.wallets.includes(t.from));
    expect(fees.length).toBe(sentTxs.length);
    for (const f of fees) {
      const tx = usdc.transactions.find((t) => t.hash === f.txHash)!;
      expect(f.amount).toBe(tx.gasUsed! * tx.effectiveGasPrice!);
      expect(f.priceUsd).toBe(3000);
    }
  });

  it("Bitcoin ledger reproduces funded/spent totals", async () => {
    for (const a of btcExpected.addresses) {
      const rows = await indexer.db.rows(ledgerEntries, sql`WHERE wallet = ${a} AND chain = 'bitcoin'`);
      const received = rows.filter((r) => r.direction === "in").reduce((s, r) => s + r.amount, 0n);
      const sent = rows.filter((r) => r.direction === "out" && r.kind === "btc").reduce((s, r) => s + r.amount, 0n);
      expect(received).toBe(btcExpected.stats[a]!.funded);
      expect(sent).toBe(btcExpected.stats[a]!.spent);
    }
  });

  it("daily flows materialized view and query helpers agree with the ledger", async () => {
    const w = usdcExpected.wallets[0]!;
    const series = await balanceSeries(indexer.db, w, { chain: "base" });
    const usdcSeries = series.filter((p) => p.asset === usdcExpected.token);
    expect(usdcSeries.length).toBeGreaterThan(0);
    const last = usdcSeries.at(-1)!;
    const { start, end } = usdcExpected.balances[w]!;
    expect(last.balance, JSON.stringify(series, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(end - start);
    const flows = await flowsInPeriod(indexer.db, w, new Date("2020-01-01"), new Date("2100-01-01"));
    const f = flows.find((x) => x.asset === usdcExpected.token)!;
    expect(f.inflow - f.outflow).toBe(end - start);
    const mv = await indexer.db.query<{ n: string }>(sql`SELECT count() AS n FROM ${walletDailyFlows}`);
    expect(Number(mv[0]!.n)).toBeGreaterThan(0);
    expect(priceCalls.length).toBeGreaterThan(0);
  });

  it("re-indexing one wallet rebuilds exactly the same rows", async () => {
    const w = usdcExpected.wallets[1]!;
    const before = await indexer.db.rows(ledgerEntries, sql`WHERE wallet = ${w} ORDER BY block_number, log_index, direction`);
    await indexer.reindex({ chain: "base", scope: "wallet", value: w });
    await indexer.run();
    const after = await indexer.db.rows(ledgerEntries, sql`WHERE wallet = ${w} ORDER BY block_number, log_index, direction`);
    expect(after).toEqual(before);
  });
});
