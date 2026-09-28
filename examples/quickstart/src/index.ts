import { createIndexer } from "yail";
import config from "../yail.config.js";
import { transfers } from "./schema.js";

export const indexer = createIndexer({ config, schema: { transfers } });

indexer.on("Usdc:Transfer", async ({ event, context }) => {
  const { from, to, value } = event.args;
  const entry = {
    counterparty: from,
    amount: value,
    txHash: event.log.transactionHash,
    logIndex: event.log.logIndex,
    blockNumber: BigInt(event.block.number),
    blockTime: new Date(event.block.timestamp * 1000),
  };
  if (context.addresses.has("watched", from)) context.db.insert(transfers).values({ ...entry, wallet: from, direction: "out", counterparty: to });
  if (context.addresses.has("watched", to)) context.db.insert(transfers).values({ ...entry, wallet: to, direction: "in" });
});

export default indexer;
