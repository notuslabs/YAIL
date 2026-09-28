import { createIndexer } from "yail";
import config from "../yail.config.js";
import * as schema from "./schema.js";
import { transfers, watched } from "./schema.js";

export const indexer = createIndexer({ config, schema });

indexer.on("Usdc:Transfer", async ({ event, context }) => {
  context.db.insert(transfers).values({
    txHash: event.log.transactionHash,
    logIndex: event.log.logIndex,
    from: event.args.from,
    to: event.args.to,
    amount: event.args.value,
    blockNumber: BigInt(event.block.number),
    blockTime: new Date(event.block.timestamp * 1000),
  });
});

indexer.on("WatchedUsdc:Transfer", async ({ event, context }) => {
  const base = { txHash: event.log.transactionHash, logIndex: event.log.logIndex, amount: event.args.value, blockNumber: BigInt(event.block.number), blockTime: new Date(event.block.timestamp * 1000), backfilled: context.backfill };
  if (context.addresses.has("watched", event.args.from)) context.db.insert(watched).values({ ...base, wallet: event.args.from, direction: "out", counterparty: event.args.to });
  if (context.addresses.has("watched", event.args.to)) context.db.insert(watched).values({ ...base, wallet: event.args.to, direction: "in", counterparty: event.args.from });
});

export default indexer;
