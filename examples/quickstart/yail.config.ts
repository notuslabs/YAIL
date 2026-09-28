import { addressSet, createConfig, parseAbi, rpc } from "yail";

export const erc20Abi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

export default createConfig({
  database: { url: "http://default:yail@localhost:18123", database: "quickstart" },
  chains: {
    // Public RPC, no key. For history, use hypersync({ url: "https://base.hypersync.xyz" }) with ENVIO_API_TOKEN.
    base: { id: 8453, source: rpc({ url: "https://mainnet.base.org" }) },
  },
  contracts: {
    // USDC transfers that touch a wallet in the "watched" set. Register wallets while it runs.
    Usdc: {
      abi: erc20Abi,
      chain: "base",
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      startBlock: "latest",
      filter: [
        { event: "Transfer", args: { from: addressSet("watched") } },
        { event: "Transfer", args: { to: addressSet("watched") } },
      ],
    },
  },
});
