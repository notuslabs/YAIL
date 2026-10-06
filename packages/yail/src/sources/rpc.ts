import { createPublicClient, http, type PublicClient } from "viem";
import type { EvmBatch, EvmBlock, EvmLog, EvmQuery, EvmSource, EvmTransaction, EvmTxFilter, FetchOptions, SolanaSource } from "./types.js";
import { lower } from "./types.js";
import { lowerOrNull, mapLimit } from "../util.js";
import { solanaRpc, type SolanaRpcOptions } from "./solana/rpc.js";

export type { SolanaRpcOptions };

export interface RpcSourceOptions {
  /** The chain's kind. Default "evm"; `{ kind: "solana" }` takes `SolanaRpcOptions`. */
  kind?: "evm";
  url: string;
  /** Blocks per eth_getLogs request. Default 2000 (most public RPCs cap at 2k-10k). */
  blockRange?: number;
  /** Fetch receipts (gasUsed, status) for matched account transactions. Default true. */
  receipts?: boolean;
  /** Max concurrent RPC requests. Default 4. */
  concurrency?: number;
  /** Optional viem client override (testing). */
  client?: PublicClient;
}

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
  removed?: boolean;
}

/**
 * JSON-RPC source. Slower than HyperSync but works against any node,
 * needs no token, and is what the recorded test fixtures are captured with.
 * Account (from/to) filters require scanning full blocks; keep ranges small.
 */
export function rpc(options: RpcSourceOptions): EvmSource;
/** Solana wallets over JSON-RPC, address by address: any slot, cost grows with the wallets' transactions. */
export function rpc(options: SolanaRpcOptions): SolanaSource;
export function rpc(options: RpcSourceOptions | SolanaRpcOptions): EvmSource | SolanaSource {
  if (options.kind === "solana") return solanaRpc(options);
  return evmRpc(options);
}

function evmRpc(options: RpcSourceOptions): EvmSource {
  const client = options.client ?? createPublicClient({ transport: http(options.url, { batch: true, retryCount: 5 }) });
  const blockRange = options.blockRange ?? 2000;
  const concurrency = options.concurrency ?? 4;

  const source: EvmSource = {
    kind: "evm",
    name: `rpc(${safeHost(options.url)})`,
    async getHeight() {
      return Number(await client.getBlockNumber());
    },
    async *fetch(query: EvmQuery, fetchOptions?: FetchOptions) {
      let from = query.fromBlock;
      while (from < query.toBlock) {
        fetchOptions?.signal?.throwIfAborted();
        const to = Math.min(from + blockRange, query.toBlock);
        yield await fetchRange(from, to, query);
        from = to;
      }
    },
    async getBlock(number: number) {
      const b = await client.getBlock({ blockNumber: BigInt(number) }).catch(() => null);
      if (!b) return null;
      return { number: Number(b.number), hash: b.hash, parentHash: b.parentHash, timestamp: Number(b.timestamp) };
    },
  };

  async function fetchRange(from: number, to: number, query: EvmQuery): Promise<EvmBatch> {
    if (query.join) throw new Error("rpc(): whole-transaction queries (accounts with `activity: true`) need a HyperSync source");
    const logs: EvmLog[] = [];
    const seenLogs = new Set<string>();
    for (const f of query.logs) {
      const params: Record<string, unknown> = { fromBlock: hex(from), toBlock: hex(to - 1) };
      if (f.address && f.address.length > 0) params.address = f.address.map(lower);
      if (f.topics) params.topics = f.topics.map(topicAlternatives);
      const raw = (await client.request({ method: "eth_getLogs", params: [params as any] })) as unknown as RawLog[];
      for (const l of raw) {
        const key = `${l.blockNumber}:${l.logIndex}`;
        if (seenLogs.has(key)) continue;
        seenLogs.add(key);
        logs.push({
          blockNumber: Number(l.blockNumber),
          blockHash: l.blockHash,
          transactionHash: l.transactionHash,
          transactionIndex: Number(l.transactionIndex),
          logIndex: Number(l.logIndex),
          address: lower(l.address),
          data: l.data,
          topics: l.topics,
          removed: l.removed,
        });
      }
    }
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

    const blocks = new Map<number, EvmBlock>();
    const transactions = new Map<string, EvmTransaction>();
    const needTxOfLogs = query.includeLogTransactions === true;
    const wantBlocks = new Set<number>(logs.map((l) => l.blockNumber));

    const logTxHashes = new Set<string>();
    if (needTxOfLogs) for (const l of logs) logTxHashes.add(l.transactionHash);
    if (query.transactions.length > 0) {
      // Account filters: scan every block in range with its transactions.
      const numbers = Array.from({ length: to - from }, (_, i) => from + i);
      await mapLimit(numbers, concurrency, async (n) => {
        const b = await client.getBlock({ blockNumber: BigInt(n), includeTransactions: true });
        blocks.set(n, { number: n, hash: b.hash, parentHash: b.parentHash, timestamp: Number(b.timestamp) });
        for (const tx of b.transactions) {
          if (typeof tx === "string") continue;
          if (matchesTxFilters(tx.from, tx.to, query.transactions) || logTxHashes.has(tx.hash)) {
            transactions.set(tx.hash, toTx(tx, n));
          }
        }
      });
    }

    const missingBlocks = [...wantBlocks].filter((n) => !blocks.has(n));
    await mapLimit(missingBlocks, concurrency, async (n) => {
      const b = await client.getBlock({ blockNumber: BigInt(n), includeTransactions: needTxOfLogs });
      blocks.set(n, { number: n, hash: b.hash, parentHash: b.parentHash, timestamp: Number(b.timestamp) });
      if (needTxOfLogs) {
        const wanted = new Set(logs.filter((l) => l.blockNumber === n).map((l) => l.transactionHash));
        for (const tx of b.transactions) {
          if (typeof tx === "string") continue;
          if (wanted.has(tx.hash)) transactions.set(tx.hash, toTx(tx, n));
        }
      }
    });

    if (options.receipts !== false && transactions.size > 0) {
      await mapLimit([...transactions.values()], concurrency, async (tx) => {
        const r = await client.getTransactionReceipt({ hash: tx.hash as `0x${string}` }).catch(() => null);
        if (!r) return;
        tx.gasUsed = r.gasUsed;
        tx.effectiveGasPrice = r.effectiveGasPrice;
        tx.status = 0;
        if (r.status === "success") tx.status = 1;
        tx.contractAddress = lowerOrNull(r.contractAddress);
      });
    }

    return {
      fromBlock: from,
      nextBlock: to,
      blocks: [...blocks.values()].sort((a, b) => a.number - b.number),
      transactions: [...transactions.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex),
      logs,
    };
  }

  return source;
}

function toTx(tx: any, blockNumber: number): EvmTransaction {
  return {
    hash: tx.hash,
    blockNumber,
    transactionIndex: Number(tx.transactionIndex),
    from: lower(tx.from),
    to: lowerOrNull(tx.to),
    value: BigInt(tx.value ?? 0),
    input: tx.input ?? "0x",
    nonce: optionalBigInt(tx.nonce),
    gas: optionalBigInt(tx.gas),
    gasPrice: optionalBigInt(tx.gasPrice),
    type: optionalHexNumber(tx.typeHex),
  };
}

function optionalBigInt(value: unknown): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  return BigInt(value as string | number | bigint);
}

function optionalHexNumber(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  return Number(value);
}

/** eth_getLogs wants a single topic as a string and alternatives as an array. */
function topicAlternatives(alts: string[] | null): string | string[] | null {
  if (alts === null) return null;
  if (alts.length === 1) return alts[0]!;
  return alts;
}

export function matchesTxFilters(from: string, to: string | null | undefined, filters: EvmTxFilter[]): boolean {
  const f = lower(from);
  const t = lowerOrNull(to);
  return filters.some((filter) => {
    const fromOk = !filter.from || filter.from.length === 0 || filter.from.map(lower).includes(f);
    const toOk = !filter.to || filter.to.length === 0 || (t !== null && filter.to.map(lower).includes(t));
    return fromOk && toOk;
  });
}

function hex(n: number): `0x${string}` {
  return `0x${n.toString(16)}`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
