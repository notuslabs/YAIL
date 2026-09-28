import { addressSet, cached, createConfig, esplora, hypersync, type ChainConfig } from "yail";
import { erc20Abi } from "./src/abis.js";

const token = process.env.ENVIO_API_TOKEN;

const evm = (name: string, id: number, startBlock: number): ChainConfig => ({
  id,
  source: hypersync({ url: `https://${name}.hypersync.xyz`, apiToken: token }),
  rpc: process.env[`${name.toUpperCase()}_RPC_URL`],
  finality: 30,
  ...({ startBlock } as {}),
});

/**
 * The production configuration: EVM chains through HyperSync, Bitcoin through
 * Esplora. Wallets are registered at runtime (`yail addresses add`, POST /addresses
 * or `indexer.addresses.register`) into the `wallets` / `btcWallets` sets and
 * backfilled from each chain's startBlock.
 */
export default createConfig({
  database: { url: process.env.CLICKHOUSE_URL ?? "http://default:@localhost:8123", database: process.env.CLICKHOUSE_DATABASE ?? "wallet_ledger" },
  chains: {
    base: evm("base", 8453, Number(process.env.BASE_START_BLOCK ?? 30_000_000)),
    polygon: evm("polygon", 137, Number(process.env.POLYGON_START_BLOCK ?? 70_000_000)),
    arbitrum: evm("arbitrum", 42161, Number(process.env.ARBITRUM_START_BLOCK ?? 350_000_000)),
    bitcoin: { id: "bitcoin", source: esplora({ url: process.env.ESPLORA_URL ?? "https://mempool.space/api" }), finality: 3, pollInterval: 60_000 },
  },
  contracts: {
    // No `address`: every ERC-20 on the chain. The topic filter keeps it to transfers touching a registered wallet.
    Erc20: {
      abi: erc20Abi,
      chain: {
        base: { startBlock: Number(process.env.BASE_START_BLOCK ?? 30_000_000) },
        polygon: { startBlock: Number(process.env.POLYGON_START_BLOCK ?? 70_000_000) },
        arbitrum: { startBlock: Number(process.env.ARBITRUM_START_BLOCK ?? 350_000_000) },
      },
      filter: [
        { event: "Transfer", args: { from: addressSet("wallets") } },
        { event: "Transfer", args: { to: addressSet("wallets") } },
      ],
    },
  },
  accounts: {
    // Native coin movements + gas of the registered wallets.
    Wallets: {
      address: addressSet("wallets"),
      chain: {
        base: { startBlock: Number(process.env.BASE_START_BLOCK ?? 30_000_000) },
        polygon: { startBlock: Number(process.env.POLYGON_START_BLOCK ?? 70_000_000) },
        arbitrum: { startBlock: Number(process.env.ARBITRUM_START_BLOCK ?? 350_000_000) },
      },
    },
    BtcWallets: { chain: "bitcoin", address: addressSet("btcWallets"), startBlock: Number(process.env.BITCOIN_START_BLOCK ?? 800_000) },
  },
  cache: { source: false, http: true, rpc: true },
  observability: { serviceName: "wallet-ledger", logsToClickHouse: true },
  server: { port: Number(process.env.PORT ?? 42069) },
});

export { cached };
