import { createIndexer } from "@notuslabs/yail";
import config from "../yail.config.js";
import { onBitcoinTransaction, onTransaction, onTransfer } from "./handlers.js";
import * as schema from "./schema.js";

export const indexer = createIndexer({ config, schema });

indexer.on("Erc20:Transfer", onTransfer);
indexer.on("Wallets:transaction", onTransaction);
indexer.on("BtcWallets:transaction", onBitcoinTransaction);

export default indexer;
