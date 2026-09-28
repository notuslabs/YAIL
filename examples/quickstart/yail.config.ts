import { addressSet, createConfig, parseAbi, rpc } from "yail";

export const erc20Abi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export default createConfig({
  database: { url: process.env.CLICKHOUSE_URL ?? "http://default:yail@localhost:18123", database: "quickstart" },
  chains: {
    // Public RPC, no key. Swap for hypersync({ url: "https://base.hypersync.xyz" }) once you have an ENVIO_API_TOKEN.
    base: { id: 8453, source: rpc({ url: process.env.BASE_RPC_URL ?? "https://mainnet.base.org", blockRange: 500 }), finality: 10, pollInterval: 4000 },
  },
  contracts: {
    // 1) Firehose: every USDC transfer from the moment the indexer starts.
    Usdc: { abi: erc20Abi, chain: "base", address: USDC, startBlock: "latest" },
    // 2) Dynamic: USDC transfers touching wallets you register at runtime, backfilled 5000 blocks (~3h) before the start.
    WatchedUsdc: {
      abi: erc20Abi,
      chain: "base",
      address: USDC,
      startBlock: "latest",
      filter: [{ event: "Transfer", args: { from: addressSet("watched") } }, { event: "Transfer", args: { to: addressSet("watched") } }],
    },
  },
  observability: { serviceName: "quickstart" },
  server: { port: 42069 },
});
