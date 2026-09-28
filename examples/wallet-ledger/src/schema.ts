import { t, table } from "yail";

/** One row per movement of value into or out of a registered wallet, in the asset's smallest unit. */
export const ledger = table(
  "ledger",
  {
    chain: t.string().lowCardinality(),
    wallet: t.address(),
    /** Token contract, "native" for the chain's coin, or "btc". */
    asset: t.address().lowCardinality(),
    kind: t.enum(["token", "native", "fee", "btc"]),
    direction: t.enum(["in", "out"]),
    amount: t.uint256(),
    counterparty: t.string(),
    txHash: t.hash(),
    logIndex: t.int32(),
    blockNumber: t.uint64(),
    blockTime: t.dateTime(),
  },
  {
    orderBy: ["wallet", "chain", "asset", "txHash", "logIndex", "direction"],
    partitionBy: "toYYYYMM(block_time)",
    scopes: { wallet: "wallet" },
  },
);
