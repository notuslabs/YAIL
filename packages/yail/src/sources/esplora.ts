import type { BitcoinBatch, BitcoinQuery, BitcoinSource, BitcoinTransaction, FetchOptions } from "./types.js";

export interface EsploraOptions {
  /** Esplora-compatible base URL: https://mempool.space/api or https://blockstream.info/api (or your own electrs). */
  url: string;
  /** Max parallel address scans. Public instances rate-limit aggressively; default 2. */
  concurrency?: number;
  /** Extra headers (e.g. API key for a hosted instance). */
  headers?: Record<string, string>;
  /** Override fetch (testing). */
  fetch?: typeof fetch;
  /** Max transactions per yielded batch. Default 500. */
  batchSize?: number;
}

interface EsploraTx {
  txid: string;
  fee: number;
  vin: Array<{ txid: string; vout: number; is_coinbase: boolean; prevout: { scriptpubkey_address?: string; value: number } | null }>;
  vout: Array<{ scriptpubkey_address?: string; scriptpubkey_type?: string; value: number }>;
  status: { confirmed: boolean; block_height?: number; block_hash?: string; block_time?: number };
}

/**
 * Bitcoin source backed by an Esplora HTTP API (mempool.space, blockstream.info,
 * or self-hosted electrs). HyperSync has no Bitcoin support and Bitcoin Core's
 * RPC has no address index, so address history is scanned through Esplora.
 * Each query scans the requested addresses newest-first and keeps confirmed
 * transactions inside [fromBlock, toBlock).
 */
export function esplora(options: EsploraOptions): BitcoinSource {
  const doFetch = options.fetch ?? fetch;
  const base = options.url.replace(/\/$/, "");
  const concurrency = options.concurrency ?? 2;

  async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    let attempt = 0;
    for (;;) {
      const res = await doFetch(`${base}${path}`, { headers: options.headers, signal });
      if (res.status === 429 || res.status >= 500) {
        attempt++;
        if (attempt > 6) throw new Error(`esplora ${path}: HTTP ${res.status} after ${attempt} attempts`);
        await sleep(Math.min(30_000, 500 * 2 ** attempt), signal);
        continue;
      }
      if (!res.ok) throw new Error(`esplora ${path}: HTTP ${res.status} ${await res.text().catch(() => "")}`);
      const text = await res.text();
      return (text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text) as T;
    }
  }

  async function scanAddress(address: string, fromBlock: number, toBlock: number, signal?: AbortSignal): Promise<EsploraTx[]> {
    const out: EsploraTx[] = [];
    let lastSeen: string | undefined;
    for (;;) {
      signal?.throwIfAborted();
      const page = await getJson<EsploraTx[]>(`/address/${address}/txs/chain${lastSeen ? `/${lastSeen}` : ""}`, signal);
      if (page.length === 0) break;
      let reachedBottom = false;
      for (const tx of page) {
        const h = tx.status.block_height;
        if (!tx.status.confirmed || h === undefined) continue;
        if (h < fromBlock) {
          reachedBottom = true;
          break;
        }
        if (h < toBlock) out.push(tx);
      }
      if (reachedBottom || page.length < 25) break;
      lastSeen = page[page.length - 1]!.txid;
    }
    return out;
  }

  return {
    kind: "bitcoin",
    name: `esplora(${new URL(base).host})`,
    async getHeight() {
      const h = await getJson<number | string>("/blocks/tip/height");
      return Number(h);
    },
    async *fetch(query: BitcoinQuery, fetchOptions?: FetchOptions) {
      const byId = new Map<string, EsploraTx>();
      let i = 0;
      const addrs = query.addresses;
      const workers = Array.from({ length: Math.min(concurrency, addrs.length) }, async () => {
        while (i < addrs.length) {
          const a = addrs[i++]!;
          const txs = await scanAddress(a, query.fromBlock, query.toBlock, fetchOptions?.signal);
          for (const tx of txs) byId.set(tx.txid, tx);
        }
      });
      await Promise.all(workers);
      const txs = [...byId.values()]
        .map(toTransaction)
        .sort((a, b) => a.blockHeight - b.blockHeight || a.txid.localeCompare(b.txid));
      const size = options.batchSize ?? 500;
      if (txs.length === 0) {
        yield { fromBlock: query.fromBlock, nextBlock: query.toBlock, transactions: [] } satisfies BitcoinBatch;
        return;
      }
      let from = query.fromBlock;
      for (let start = 0; start < txs.length; start += size) {
        const chunk = txs.slice(start, start + size);
        const last = start + size >= txs.length;
        // Batches must not split a block: extend chunk to include the rest of its last block.
        let end = start + size;
        while (!last && end < txs.length && txs[end]!.blockHeight === chunk[chunk.length - 1]!.blockHeight) {
          chunk.push(txs[end]!);
          end++;
        }
        const next = last ? query.toBlock : chunk[chunk.length - 1]!.blockHeight + 1;
        yield { fromBlock: from, nextBlock: next, transactions: chunk } satisfies BitcoinBatch;
        from = next;
        start = end - size;
      }
    },
  };
}

function toTransaction(tx: EsploraTx): BitcoinTransaction {
  return {
    txid: tx.txid,
    blockHeight: tx.status.block_height!,
    blockHash: tx.status.block_hash ?? "",
    blockTime: tx.status.block_time ?? 0,
    fee: BigInt(tx.fee ?? 0),
    vin: tx.vin.map((v) => ({
      txid: v.txid,
      vout: v.vout,
      isCoinbase: v.is_coinbase,
      prevout: v.prevout ? { address: v.prevout.scriptpubkey_address ?? null, value: BigInt(v.prevout.value) } : null,
    })),
    vout: tx.vout.map((o, n) => ({ n, address: o.scriptpubkey_address ?? null, value: BigInt(o.value), scriptType: o.scriptpubkey_type })),
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });
}
