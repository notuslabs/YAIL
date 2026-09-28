import { createIndexer, type Config, type HandlerContext } from "yail";
import { erc20Abi } from "./abis.js";
import * as schema from "./schema.js";
import { ledgerEntries, tokens } from "./schema.js";

export interface LedgerOptions {
  /** Return the USD price of one whole unit at a timestamp, or null. Defaults to DefiLlama through the cached HTTP client. */
  priceAt?: (context: HandlerContext<any, any>, chain: string, asset: string, timestamp: number) => Promise<number | null>;
  fetch?: typeof fetch;
}

const LLAMA_CHAINS: Record<string, string> = { base: "base", polygon: "polygon", arbitrum: "arbitrum", ethereum: "ethereum", bitcoin: "coingecko" };

/** Historical USD price via DefiLlama, cached forever in ClickHouse (historical prices never change). */
export async function defiLlamaPrice(context: HandlerContext<any, any>, chain: string, asset: string, timestamp: number): Promise<number | null> {
  const key = chain === "bitcoin" ? "coingecko:bitcoin" : `${LLAMA_CHAINS[chain] ?? chain}:${asset === "native" ? "0x0000000000000000000000000000000000000000" : asset}`;
  const res = await context.http.get(`https://coins.llama.fi/prices/historical/${timestamp}/${encodeURIComponent(key)}?searchWidth=4h`, { cache: true });
  if (!res.ok) return null;
  const price = res.json<{ coins: Record<string, { price: number }> }>().coins[key]?.price;
  return typeof price === "number" ? price : null;
}

/**
 * Attach the ledger handlers to a config. The config decides the data
 * sources (HyperSync in production, recorded fixtures in tests) and which
 * chains exist; the handlers are the same either way.
 */
export function createLedgerIndexer<C extends Config<any, any, any>>(config: C, options: LedgerOptions = {}) {
  const indexer = createIndexer({ config, schema, fetch: options.fetch });
  const priceAt = options.priceAt ?? (process.env.LEDGER_PRICES === "1" ? defiLlamaPrice : async () => null);

  const rememberToken = async (context: HandlerContext<any, any>, address: string) => {
    if (!context.client) return; // no RPC configured for this chain
    if (await context.db.find(tokens, { chain: context.chain.name, address })) return;
    const [symbol, name, decimals] = await Promise.all([
      context.client.readContract({ address, abi: erc20Abi, functionName: "symbol" }).catch(() => ""),
      context.client.readContract({ address, abi: erc20Abi, functionName: "name" }).catch(() => ""),
      context.client.readContract({ address, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
    ]);
    context.db.insert(tokens).values({ chain: context.chain.name, address, symbol, name, decimals });
  };

  indexer.on("Erc20:Transfer" as any, async ({ event, context }: any) => {
    const { from, to, value } = event.args as { from: string; to: string; value: bigint };
    const chain = context.chain.name;
    const time = event.block.timestamp;
    const base = { chain, asset: event.address, kind: "transfer" as const, txHash: event.log.transactionHash, logIndex: event.log.logIndex, amount: value, blockNumber: BigInt(event.block.number), blockTime: new Date(time * 1000) };
    const fromIsWallet = context.addresses.has("wallets", from);
    const toIsWallet = context.addresses.has("wallets", to);
    if (!fromIsWallet && !toIsWallet) return;
    await rememberToken(context, event.address);
    const priceUsd = await priceAt(context, chain, event.address, time);
    if (fromIsWallet) context.db.insert(ledgerEntries).values({ ...base, wallet: from, direction: "out", counterparty: to, priceUsd });
    if (toIsWallet) context.db.insert(ledgerEntries).values({ ...base, wallet: to, direction: "in", counterparty: from, priceUsd });
    context.log.set({ transfers: 1 });
  });

  indexer.on("Wallets:transaction" as any, async ({ event, context }: any) => {
    const tx = event.transaction;
    const chain = context.chain.name;
    const time = event.block.timestamp;
    const common = { chain, asset: "native", txHash: tx.hash, blockNumber: BigInt(event.block.number), blockTime: new Date(time * 1000) };
    const priceUsd = tx.value > 0n || event.direction !== "to" ? await priceAt(context, chain, "native", time) : null;
    if (tx.value > 0n && (tx.status ?? 1) === 1) {
      if (event.direction === "from" || event.direction === "self") context.db.insert(ledgerEntries).values({ ...common, kind: "native", wallet: event.address, direction: "out", logIndex: -1, amount: tx.value, counterparty: tx.to ?? "", priceUsd });
      if (event.direction === "to" || event.direction === "self") context.db.insert(ledgerEntries).values({ ...common, kind: "native", wallet: event.address, direction: "in", logIndex: -1, amount: tx.value, counterparty: tx.from, priceUsd });
    }
    if (event.direction !== "to" && tx.gasUsed !== undefined && tx.effectiveGasPrice !== undefined) {
      context.db.insert(ledgerEntries).values({ ...common, kind: "fee", wallet: event.address, direction: "out", logIndex: -2, amount: tx.gasUsed * tx.effectiveGasPrice, counterparty: "", priceUsd });
    }
  });

  indexer.on("BtcWallets:transaction" as any, async ({ event, context }: any) => {
    const time = event.block.time;
    const priceUsd = await priceAt(context, "bitcoin", "btc", time);
    const common = { chain: context.chain.name, asset: "btc", kind: "btc" as const, txHash: event.tx.txid, blockNumber: BigInt(event.block.height), blockTime: new Date(time * 1000), priceUsd, wallet: event.address };
    if (event.received > 0n) context.db.insert(ledgerEntries).values({ ...common, direction: "in", logIndex: 0, amount: event.received, counterparty: event.tx.vin[0]?.prevout?.address ?? "coinbase" });
    if (event.sent > 0n) context.db.insert(ledgerEntries).values({ ...common, direction: "out", logIndex: 1, amount: event.sent, counterparty: event.tx.vout.find((o: any) => o.address && o.address !== event.address)?.address ?? "" });
    if (event.isSender && event.fee > 0n) context.db.insert(ledgerEntries).values({ ...common, kind: "fee", direction: "out", logIndex: 2, amount: event.fee, counterparty: "" });
  });

  return indexer;
}
