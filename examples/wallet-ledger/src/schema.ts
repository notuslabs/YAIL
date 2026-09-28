import { materializedView, sql, t, table } from "yail";

/**
 * One row per movement of value into or out of a registered wallet.
 * `amount` is in the asset's smallest unit (wei, satoshi, token base units);
 * decimals live in `tokens`. `direction` is "in" or "out"; `kind` says why.
 */
export const ledgerEntries = table(
  "ledger_entries",
  {
    chain: t.string().lowCardinality(),
    wallet: t.address(),
    /** Token contract (lowercase), or "native" for the chain's coin, or "btc". */
    asset: t.address().lowCardinality(),
    kind: t.enum(["transfer", "native", "fee", "btc"]),
    direction: t.enum(["in", "out"]),
    txHash: t.hash(),
    /** Log index for token transfers; -1 for native value; -2 for fees; output index for BTC. */
    logIndex: t.int32(),
    amount: t.uint256(),
    counterparty: t.string(),
    blockNumber: t.uint64(),
    blockTime: t.dateTime(),
    /** USD price of one whole unit of the asset at block time, when a price source is configured. */
    priceUsd: t.float64().nullable(),
  },
  {
    orderBy: ["wallet", "chain", "asset", "txHash", "logIndex", "direction"],
    partitionBy: "toYYYYMM(block_time)",
    scopes: { wallet: "wallet", asset: "asset" },
  },
);

/** Token metadata discovered on first sight (via cached contract reads). */
export const tokens = table(
  "tokens",
  { chain: t.string().lowCardinality(), address: t.address(), symbol: t.string(), name: t.string(), decimals: t.uint8() },
  { orderBy: ["chain", "address"] },
);

/** Daily net flow per wallet/asset. Summed automatically by ClickHouse; the balance curve is a running sum over days. */
export const walletDailyFlows = table(
  "wallet_daily_flows",
  { chain: t.string().lowCardinality(), wallet: t.address(), asset: t.address().lowCardinality(), day: t.date(), inflow: t.int256(), outflow: t.int256(), movements: t.uint64() },
  { orderBy: ["wallet", "chain", "asset", "day"], engine: "SummingMergeTree", indexMeta: false },
);

export const walletDailyFlowsMv = materializedView("wallet_daily_flows_mv", {
  from: ledgerEntries,
  to: walletDailyFlows,
  query: sql`
    SELECT chain, wallet, asset, toDate(block_time) AS day,
           sumIf(toInt256(amount), direction = 'in') AS inflow,
           sumIf(toInt256(amount), direction = 'out') AS outflow,
           count() AS movements
    FROM ${ledgerEntries}
    GROUP BY chain, wallet, asset, day`,
});
