import { addressSet, createConfig, esplora, hypersync } from "yail";
import { erc20Abi } from "./src/abis.js";

// Nothing before these blocks is indexed. ENVIO_API_TOKEN is read from the environment.
const START = { base: 30_000_000, polygon: 70_000_000, arbitrum: 350_000_000 };
const evm = { base: { startBlock: START.base }, polygon: { startBlock: START.polygon }, arbitrum: { startBlock: START.arbitrum } };

let clickhouseUrl = "http://default:yail@localhost:18123";
if (process.env.CLICKHOUSE_URL) clickhouseUrl = process.env.CLICKHOUSE_URL;

export default createConfig({
  database: { url: clickhouseUrl, database: "wallet_ledger" },
  chains: {
    base: { id: 8453, source: hypersync({ url: "https://base.hypersync.xyz" }) },
    polygon: { id: 137, source: hypersync({ url: "https://polygon.hypersync.xyz" }) },
    arbitrum: { id: 42161, source: hypersync({ url: "https://arbitrum.hypersync.xyz" }) },
    bitcoin: { id: "bitcoin", source: esplora({ url: "https://mempool.space/api" }) },
  },
  contracts: {
    // Every ERC-20 (no address), but only transfers that touch a registered wallet cross the wire.
    Erc20: {
      abi: erc20Abi,
      chain: evm,
      filter: [
        { event: "Transfer", args: { from: addressSet("wallets") } },
        { event: "Transfer", args: { to: addressSet("wallets") } },
      ],
    },
  },
  accounts: {
    // Native coin movements and gas of the registered wallets.
    Wallets: { chain: evm, address: addressSet("wallets") },
    BtcWallets: { chain: "bitcoin", address: addressSet("btcWallets"), startBlock: 800_000 },
  },
});
