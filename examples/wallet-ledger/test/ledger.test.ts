import { beforeAll, describe, expect, it } from "vitest";
import { addressSet, createConfig, createIndexer, sql, type DatabaseConfig, type Indexer } from "@notuslabs/yail";
import { fixtureSource, readFixture, startTestClickHouse, type BitcoinFixture, type EvmFixture } from "@notuslabs/yail/testing";
import { erc20Abi } from "../src/abis.js";
import { onBitcoinTransaction, onTransaction, onTransfer } from "../src/handlers.js";
import { balanceSeries } from "../src/queries.js";
import * as schema from "../src/schema.js";

// Real data recorded from Base and mempool.space, with balances read from the chain at the same blocks.
const fixtures = new URL("../../../packages/yail/test/fixtures/", import.meta.url).pathname;
const usdc = readFixture<EvmFixture>(`${fixtures}base-usdc-wallets.json`);
const btc = readFixture<BitcoinFixture>(`${fixtures}bitcoin-wallets.json`);
const usdcTruth = usdc.expected as { token: string; wallets: string[]; balances: Record<string, { start: bigint; end: bigint }> };
const btcTruth = btc.expected as { addresses: string[]; stats: Record<string, { funded: bigint; spent: bigint }> };

// Same contracts, accounts and handlers as production; only the sources and the database differ.
const testConfig = (database: DatabaseConfig) =>
  createConfig({
    database,
    chains: {
      base: { id: 8453, source: fixtureSource(usdc), finality: 0 },
      bitcoin: { id: "bitcoin", source: fixtureSource(btc), finality: 0 },
    },
    addressSets: { wallets: { initial: usdcTruth.wallets }, btcWallets: { initial: btcTruth.addresses } },
    contracts: { Erc20: { abi: erc20Abi, chain: "base", startBlock: usdc.fromBlock, filter: [{ event: "Transfer", args: { from: addressSet("wallets") } }, { event: "Transfer", args: { to: addressSet("wallets") } }] } },
    accounts: { Wallets: { chain: "base", address: addressSet("wallets"), startBlock: usdc.fromBlock }, BtcWallets: { chain: "bitcoin", address: addressSet("btcWallets"), startBlock: 0 } },
    server: { port: false },
  });

let indexer: Indexer<ReturnType<typeof testConfig>>;

beforeAll(async () => {
  const ch = await startTestClickHouse();
  indexer = createIndexer({ config: testConfig(ch.database()), schema });
  indexer.on("Erc20:Transfer", onTransfer);
  indexer.on("Wallets:transaction", onTransaction);
  indexer.on("BtcWallets:transaction", onBitcoinTransaction);
  await indexer.run();
});

describe("wallet ledger", () => {
  it("USDC balance changes match the chain for every wallet", async () => {
    for (const wallet of usdcTruth.wallets) {
      const series = await balanceSeries(indexer.db, wallet);
      const usdcPoints = series.filter((p) => p.asset === usdcTruth.token);
      const last = usdcPoints[usdcPoints.length - 1];
      expect(last, wallet).toBeDefined();
      const { start, end } = usdcTruth.balances[wallet]!;
      expect(last!.balance, wallet).toBe(end - start);
    }
  });

  it("Bitcoin received/sent totals match Esplora", async () => {
    for (const address of btcTruth.addresses) {
      const rows = await indexer.db.rows(schema.ledger, sql`WHERE wallet = ${address} AND kind = 'btc'`);
      const sum = (direction: string) => rows.filter((r) => r.direction === direction).reduce((s, r) => s + r.amount, 0n);
      expect(sum("in"), address).toBe(btcTruth.stats[address]!.funded);
      expect(sum("out"), address).toBe(btcTruth.stats[address]!.spent);
    }
  });

  it("re-indexing one wallet rebuilds the same rows", async () => {
    const wallet = usdcTruth.wallets[0]!;
    const before = await indexer.db.rows(schema.ledger, sql`WHERE wallet = ${wallet} ORDER BY block_number, log_index, direction`);
    await indexer.reindex({ chain: "base", scope: "wallet", value: wallet });
    await indexer.run();
    const after = await indexer.db.rows(schema.ledger, sql`WHERE wallet = ${wallet} ORDER BY block_number, log_index, direction`);
    expect(after).toEqual(before);
    expect(after.length).toBeGreaterThan(0);
  });
});
