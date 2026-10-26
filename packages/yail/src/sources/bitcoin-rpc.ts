import type { BitcoinQuery, BitcoinSource, BitcoinTransaction, FetchOptions } from "./types.js";
import { counted, requestListeners } from "../util.js";
import { jsonRpc } from "./solana/json-rpc.js";

export interface BitcoinRpcOptions {
  kind: "bitcoin";
  /** Bitcoin Core JSON-RPC URL (Alchemy, QuickNode, your own node ≥ 25): `getblock` must answer verbosity 3. */
  url: string;
  headers?: Record<string, string>;
  /** Override fetch (testing). */
  fetch?: typeof fetch;
}

interface RpcOutput {
  value: number;
  scriptPubKey: { address?: string; type?: string };
}

interface RpcTx {
  txid: string;
  fee?: number;
  vin: Array<{ txid?: string; vout?: number; coinbase?: string; prevout?: RpcOutput }>;
  vout: Array<RpcOutput & { n: number }>;
}

interface RpcBlock {
  hash: string;
  time: number;
  tx: RpcTx[];
}

/**
 * Bitcoin source over Bitcoin Core JSON-RPC: one `getblock` with verbosity 3 (every input with the output it spends)
 * per block, kept to the transactions of the query's addresses. Cost grows with the range, not with the addresses, so
 * the live loop can catch up from any distance in a few thousand calls. Core has no address index: backfills of newly
 * registered addresses need `esplora()` as the chain's `backfillSource`.
 */
export function bitcoinRpc(options: BitcoinRpcOptions): BitcoinSource {
  const listeners = requestListeners();
  const name = `rpc(${new URL(options.url).host})`;
  const call = jsonRpc(name, { ...options, fetch: counted(options.fetch ?? fetch, listeners.count) });

  return {
    kind: "bitcoin",
    name,
    getHeight: () => call<number>("getblockcount", []),
    async *fetch(query: BitcoinQuery, fetchOptions?: FetchOptions) {
      const signal = fetchOptions?.signal;
      const addresses = new Set(query.addresses);
      const touches = (tx: RpcTx) => tx.vin.some((i) => addresses.has(i.prevout?.scriptPubKey.address ?? "")) || tx.vout.some((o) => addresses.has(o.scriptPubKey.address ?? ""));
      for (let height = query.fromBlock; height < query.toBlock; height++) {
        const hash = await call<string>("getblockhash", [height], signal);
        const block = await call<RpcBlock>("getblock", [hash, 3], signal);
        yield { fromBlock: height, nextBlock: height + 1, transactions: block.tx.filter(touches).map((tx) => toTransaction(tx, height, block)) };
      }
    },
    onRequest: listeners.onRequest,
  };
}

/** BTC amounts as satoshis: below 2^53 / 1e8 BTC the rounded product is exact. */
const sats = (btc: number) => BigInt(Math.round(btc * 1e8));

function toTransaction(tx: RpcTx, height: number, block: RpcBlock): BitcoinTransaction {
  return {
    txid: tx.txid,
    blockHeight: height,
    blockHash: block.hash,
    blockTime: block.time,
    fee: sats(tx.fee ?? 0),
    vin: tx.vin.map((i) => ({
      txid: i.txid ?? "",
      vout: i.vout ?? 0,
      isCoinbase: i.coinbase !== undefined,
      prevout: i.prevout ? { address: i.prevout.scriptPubKey.address ?? null, value: sats(i.prevout.value) } : null,
    })),
    vout: tx.vout.map((o) => ({ n: o.n, address: o.scriptPubKey.address ?? null, value: sats(o.value), scriptType: o.scriptPubKey.type })),
  };
}
