import { HypersyncClient, JoinMode, type LogField, type LogFilter, type Query, type QueryResponse, type StreamConfig, type TraceField, type TransactionField, type Log as HsLog, type Transaction as HsTx, type Block as HsBlock, type Trace as HsTrace } from "@envio-dev/hypersync-client";
import type { EvmBatch, EvmBlock, EvmLog, EvmQuery, EvmSource, EvmTrace, EvmTransaction, FetchOptions } from "./types.js";
import { logOrder, lower, txOrder } from "./types.js";
import { lowerOrNull } from "../util.js";

export interface HypersyncOptions {
  /** e.g. https://base.hypersync.xyz (see https://docs.envio.dev/docs/HyperSync/hypersync-supported-networks). */
  url: string;
  /**
   * A trace-enabled endpoint (e.g. https://base-traces.hypersync.xyz, a paid add-on) for the queries that ask for
   * traces. Some of them hold less history than the plain endpoint: before `fromBlock` those queries go to `url`,
   * without traces, rather than coming back empty.
   */
  traces?: { url: string; fromBlock?: number };
  /** Envio API token (https://app.envio.dev/api-tokens). Falls back to ENVIO_API_TOKEN. */
  apiToken?: string;
  maxNumRetries?: number;
  httpReqTimeoutMillis?: number;
  /** Parallel requests used by the streaming path for large ranges. Default 8. */
  concurrency?: number;
  /** Use the parallel stream API when a range spans at least this many blocks. Default 5000. */
  streamThreshold?: number;
  /** Target response size hint for the stream API. Default 400k. */
  responseBytesTarget?: number;
}

const BLOCK_FIELDS = ["Number", "Hash", "ParentHash", "Timestamp"] as const;
const LOG_FIELDS = ["BlockNumber", "BlockHash", "TransactionHash", "TransactionIndex", "LogIndex", "Address", "Data", "Topic0", "Topic1", "Topic2", "Topic3", "Removed"] as const;
const TX_FIELDS = ["Hash", "BlockNumber", "TransactionIndex", "From", "To", "Value", "Input", "Nonce", "Gas", "GasPrice", "GasUsed", "EffectiveGasPrice", "L1Fee", "Status", "Type", "ContractAddress"] as const;
const TRACE_FIELDS = ["TransactionHash", "BlockNumber", "TraceAddress", "Type", "CallType", "From", "To", "Value", "Error"] as const;

export function hypersync(options: HypersyncOptions): EvmSource {
  const clients = new Map<string, HypersyncClient>();
  const getClient = (url = options.url) => {
    // Resolved lazily so `yail ddl` / `yail migrate` work without a token.
    const apiToken = options.apiToken ?? process.env.ENVIO_API_TOKEN;
    if (!apiToken) {
      throw new Error(`hypersync(${url}): missing apiToken. Pass it explicitly or set ENVIO_API_TOKEN (https://app.envio.dev/api-tokens).`);
    }
    let client = clients.get(url);
    if (!client) {
      client = new HypersyncClient({ url, apiToken, maxNumRetries: options.maxNumRetries ?? 12, httpReqTimeoutMillis: options.httpReqTimeoutMillis ?? 30_000 });
      clients.set(url, client);
    }
    return client;
  };

  /** Queries that ask for traces go to the traces endpoint from its first block; everything else to the plain one. */
  async function* fetchRouted(query: EvmQuery, fetchOptions?: FetchOptions): AsyncGenerator<EvmBatch> {
    const wantsTraces = (query.traces?.length ?? 0) > 0 || query.join === true;
    if (!wantsTraces || !options.traces) {
      yield* fetchFrom(options.url, query, false, fetchOptions);
      return;
    }
    const from = Math.max(query.fromBlock, options.traces.fromBlock ?? 0);
    if (query.fromBlock < from) yield* fetchFrom(options.url, { ...query, toBlock: Math.min(query.toBlock, from), traces: [] }, false, fetchOptions);
    if (from < query.toBlock) yield* fetchFrom(options.traces.url, { ...query, fromBlock: from }, true, fetchOptions);
  }

  async function* fetchFrom(url: string, query: EvmQuery, withTraces: boolean, fetchOptions?: FetchOptions): AsyncGenerator<EvmBatch> {
    const hsQuery = toHypersyncQuery(query, withTraces);
    const span = query.toBlock - query.fromBlock;
    const threshold = options.streamThreshold ?? 5000;
    if (span >= threshold) {
      yield* streamRange(getClient(url), hsQuery, query, options, fetchOptions);
    } else {
      yield* getRange(getClient(url), hsQuery, query, fetchOptions);
    }
  }

  const source: EvmSource = {
    kind: "evm",
    name: `hypersync(${new URL(options.url).host})`,
    async getHeight() {
      return getClient().getHeight();
    },
    async *fetch(query: EvmQuery, fetchOptions?: FetchOptions) {
      // A joined query returns every matched transaction whole, so plain log filters must not ride along with it:
      // every swap of a DEX would come back with its transaction and traces. They are fetched apart and merged by block.
      const plain = query.logs.filter((f) => !f.join);
      if (query.join && plain.length > 0 && plain.length < query.logs.length) {
        const joined = { ...query, logs: query.logs.filter((f) => f.join) };
        const rest: EvmQuery = { ...query, logs: plain, transactions: [], traces: [], join: false };
        yield* mergeByBlock(fetchRouted(rest, fetchOptions), fetchRouted(joined, fetchOptions), query.toBlock);
        return;
      }
      yield* fetchRouted(query, fetchOptions);
    },
    async getBlock(number: number) {
      const res = await getClient().get({
        fromBlock: number,
        toBlock: number + 1,
        includeAllBlocks: true,
        fieldSelection: { block: [...BLOCK_FIELDS] },
      });
      const b = res.data.blocks[0];
      if (!b) return null;
      return toBlock(b);
    },
  };
  return source;
}

/**
 * Two streams over the same block range as one: each batch of `main` comes out with what `other` has for the same
 * blocks. `other` is read ahead as far as the batch reaches, its surplus kept for the next one.
 */
async function* mergeByBlock(main: AsyncGenerator<EvmBatch>, other: AsyncGenerator<EvmBatch>, toBlock: number): AsyncGenerator<EvmBatch> {
  const held: EvmBatch = { fromBlock: 0, nextBlock: 0, blocks: [], transactions: [], logs: [], traces: [] };
  let covered = 0;
  for await (const batch of main) {
    while (covered < Math.min(batch.nextBlock, toBlock)) {
      const next = await other.next();
      if (next.done) break;
      covered = next.value.nextBlock;
      held.blocks.push(...next.value.blocks);
      held.transactions.push(...next.value.transactions);
      held.logs.push(...next.value.logs);
      held.traces!.push(...(next.value.traces ?? []));
      held.archiveHeight = next.value.archiveHeight;
    }
    const inBatch = (block: number) => block < batch.nextBlock;
    const split = <T>(items: T[], block: (item: T) => number): T[] => {
      const [taken, kept] = [items.filter((item) => inBatch(block(item))), items.filter((item) => !inBatch(block(item)))];
      items.splice(0, items.length, ...kept);
      return taken;
    };
    const blocks = new Map([...batch.blocks, ...split(held.blocks, (b) => b.number)].map((b) => [b.number, b]));
    yield {
      ...batch,
      blocks: [...blocks.values()].sort((a, b) => a.number - b.number),
      transactions: [...batch.transactions, ...split(held.transactions, (t) => t.blockNumber)].sort(txOrder),
      logs: [...batch.logs, ...split(held.logs, (l) => l.blockNumber)].sort(logOrder),
      traces: [...(batch.traces ?? []), ...split(held.traces!, (t) => t.blockNumber)],
      archiveHeight: Math.min(batch.archiveHeight ?? Infinity, held.archiveHeight ?? Infinity),
    };
  }
  await other.return(undefined);
}

async function* getRange(client: HypersyncClient, hsQuery: Query, query: EvmQuery, fetchOptions?: FetchOptions): AsyncGenerator<EvmBatch> {
  let from = query.fromBlock;
  while (from < query.toBlock) {
    fetchOptions?.signal?.throwIfAborted();
    const res = await getFrom(client, hsQuery, from);
    const next = Math.min(res.nextBlock, query.toBlock);
    if (next <= from) throw new Error(`hypersync: nextBlock ${res.nextBlock} did not advance from ${from}`);
    yield toBatch(res, from, next);
    from = next;
  }
}

async function* streamRange(client: HypersyncClient, hsQuery: Query, query: EvmQuery, options: HypersyncOptions, fetchOptions?: FetchOptions): AsyncGenerator<EvmBatch> {
  const cfg: StreamConfig = {
    concurrency: options.concurrency ?? 8,
    responseBytesTarget: options.responseBytesTarget ?? 400_000,
  };
  const stream = await client.stream(hsQuery, cfg);
  let from = query.fromBlock;
  try {
    while (from < query.toBlock) {
      if (fetchOptions?.signal?.aborted) break;
      const res = await stream.recv();
      if (res === null) break;
      const next = Math.min(res.nextBlock, query.toBlock);
      if (next <= from) continue; // empty overlapping page
      yield toBatch(res, from, next);
      from = next;
    }
  } finally {
    await stream.close().catch(() => {});
  }
  fetchOptions?.signal?.throwIfAborted();
  // The stream API is allowed to stop early (server-side limits); cover the remainder with plain gets.
  if (from < query.toBlock) {
    yield* getRange(client, hsQuery, { ...query, fromBlock: from }, fetchOptions);
  }
}

/** Near the head, a server behind the reported height can answer without advancing: ask again before giving up. */
async function getFrom(client: HypersyncClient, hsQuery: Query, from: number): Promise<QueryResponse> {
  for (let attempt = 1; ; attempt++) {
    const res = await client.get({ ...hsQuery, fromBlock: from });
    if (res.nextBlock > from || attempt === 5) return res;
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }
}

export function toHypersyncQuery(query: EvmQuery, withTraces = true): Query {
  const traces = withTraces ? (query.traces ?? []) : [];
  const logFields: LogField[] = [];
  if (query.logs.length > 0 || query.join) logFields.push(...LOG_FIELDS);
  const txFields: TransactionField[] = [];
  if (query.transactions.length > 0 || query.includeLogTransactions || query.join) txFields.push(...TX_FIELDS);
  const traceFields: TraceField[] = [];
  if (withTraces && (traces.length > 0 || query.join)) traceFields.push(...TRACE_FIELDS);
  const hsQuery: Query = {
    fromBlock: query.fromBlock,
    toBlock: query.toBlock,
    logs: query.logs.map((f) => {
      const filter: LogFilter = { address: f.address?.map(lower) };
      if (f.topics) filter.topics = f.topics.map((alts) => alts ?? []);
      return filter;
    }),
    transactions: query.transactions.map((f) => ({ from: f.from?.map(lower), to: f.to?.map(lower) })),
    traces: traces.map((f) => ({ from: f.from?.map(lower), to: f.to?.map(lower) })),
    fieldSelection: { block: [...BLOCK_FIELDS], log: logFields, transaction: txFields, trace: traceFields },
  };
  // JoinAll: every log and trace of each matched transaction, not only the matching ones.
  if (query.join) hsQuery.joinMode = JoinMode.JoinAll;
  return hsQuery;
}

function toBatch(res: QueryResponse, fromBlock: number, nextBlock: number): EvmBatch {
  const batch: EvmBatch = {
    fromBlock,
    nextBlock,
    blocks: res.data.blocks.map(toBlock),
    transactions: res.data.transactions.map(toTransaction),
    logs: res.data.logs.map(toLog),
    traces: (res.data.traces ?? []).map(toTrace),
    archiveHeight: res.archiveHeight,
  };
  const guard = res.rollbackGuard;
  if (guard) {
    batch.rollbackGuard = { blockNumber: guard.blockNumber, hash: guard.hash, firstBlockNumber: guard.firstBlockNumber, firstParentHash: guard.firstParentHash };
  }
  return batch;
}

function toBlock(b: HsBlock): EvmBlock {
  return { number: b.number!, hash: b.hash!, parentHash: b.parentHash, timestamp: Number(b.timestamp!) };
}

function toLog(l: HsLog): EvmLog {
  return {
    blockNumber: l.blockNumber!,
    blockHash: l.blockHash,
    transactionHash: l.transactionHash!,
    transactionIndex: l.transactionIndex!,
    logIndex: l.logIndex!,
    address: lower(l.address!),
    data: l.data ?? "0x",
    topics: l.topics.filter((t): t is string => typeof t === "string" && t.length > 0),
    removed: l.removed,
  };
}

function toTrace(t: HsTrace): EvmTrace {
  return {
    transactionHash: t.transactionHash!,
    blockNumber: t.blockNumber!,
    traceAddress: t.traceAddress ?? [],
    type: t.type ?? "call",
    callType: t.callType,
    from: lower(t.from ?? ""),
    to: lowerOrNull(t.to),
    value: t.value ?? 0n,
    error: t.error,
  };
}

function toTransaction(t: HsTx): EvmTransaction {
  return {
    hash: t.hash!,
    blockNumber: t.blockNumber!,
    transactionIndex: t.transactionIndex!,
    from: lower(t.from!),
    to: lowerOrNull(t.to),
    value: t.value ?? 0n,
    input: t.input ?? "0x",
    nonce: t.nonce,
    gas: t.gas,
    gasPrice: t.gasPrice,
    gasUsed: t.gasUsed,
    effectiveGasPrice: t.effectiveGasPrice,
    l1Fee: t.l1Fee,
    status: t.status,
    type: t.type,
    contractAddress: t.contractAddress ?? null,
  };
}
