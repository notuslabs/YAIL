import { t, table } from "@notuslabs/yail";

export const transfers = table(
  "transfers",
  {
    wallet: t.address(),
    direction: t.enum(["in", "out"]),
    counterparty: t.address(),
    amount: t.uint256(),
    txHash: t.hash(),
    logIndex: t.uint32(),
    blockNumber: t.uint64(),
    blockTime: t.dateTime(),
  },
  { orderBy: ["wallet", "blockNumber", "txHash", "logIndex", "direction"], scopes: { wallet: "wallet" } },
);
