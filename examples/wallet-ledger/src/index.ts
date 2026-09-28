import "./telemetry.js";
import config from "../yail.config.js";
import { createLedgerIndexer } from "./indexer.js";

export const indexer = createLedgerIndexer(config);
export default indexer;
