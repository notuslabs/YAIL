import { materializedView, sql, t, table } from "yail";

export const transfers = table(
  "usdc_transfers",
  { txHash: t.hash(), logIndex: t.uint32(), from: t.address(), to: t.address(), amount: t.uint256(), blockNumber: t.uint64(), blockTime: t.dateTime() },
  { orderBy: ["blockNumber", "txHash", "logIndex"] },
);

export const watched = table(
  "watched_transfers",
  { wallet: t.address(), direction: t.enum(["in", "out"]), txHash: t.hash(), logIndex: t.uint32(), counterparty: t.address(), amount: t.uint256(), blockNumber: t.uint64(), blockTime: t.dateTime(), backfilled: t.bool() },
  { orderBy: ["wallet", "blockNumber", "txHash", "logIndex", "direction"], scopes: { wallet: "wallet" } },
);

export const minuteVolume = table(
  "usdc_minute_volume",
  { minute: t.dateTime(), transfers: t.uint64(), volume: t.uint256() },
  { orderBy: ["minute"], engine: "SummingMergeTree", indexMeta: false },
);

export const minuteVolumeMv = materializedView("usdc_minute_volume_mv", {
  from: transfers,
  to: minuteVolume,
  query: sql`SELECT toStartOfMinute(block_time) AS minute, count() AS transfers, sum(amount) AS volume FROM ${transfers} GROUP BY minute`,
});
