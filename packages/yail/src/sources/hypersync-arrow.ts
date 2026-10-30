import { zstdDecompressSync } from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";
import { CompressionType, RecordBatchReader, compressionRegistry, type Data, type RecordBatch } from "apache-arrow";
import type { Query } from "@envio-dev/hypersync-client";
import type { EvmBatch, EvmBlock, EvmLog, EvmQuery, EvmTrace, EvmTransaction, RollbackGuard } from "./types.js";
import type { AddressSets, EvmMatcher, LogSets } from "./match.js";
import { append } from "../util.js";

/** Compressed bytes a whole-blocks request aims at: its block span is projected from the bytes per block of the last one. */
const RESPONSE_BYTES_TARGET = 4_000_000;
/** Whole-blocks requests in flight per range. */
const CONCURRENCY = 4;

compressionRegistry.set(CompressionType.ZSTD, { decode: (data) => zstdDecompressSync(data) });

export interface ArrowWholeBlocksOptions {
  url: string;
  apiToken: string;
  maxNumRetries: number;
  httpReqTimeoutMillis: number;
  onRequest: () => void;
  /** The last response's bytes per block on this endpoint, kept across ranges so each one starts at the right span. */
  estimate: { bytesPerBlock: number };
}

/**
 * The whole blocks of `query`'s range read from HyperSync's Arrow API (`/query/arrow-ipc`: Cap'n Proto around zstd
 * Arrow IPC tables), returned as one batch of what `match` keeps. Each response is filtered column by column with
 * `match`'s Sets as it arrives and items are built only for the rows it selects, so what a range holds is its matched
 * items plus the responses in flight, not its whole blocks.
 */
export async function arrowWholeBlocks(query: EvmQuery, hsQuery: Query, match: EvmMatcher, options: ArrowWholeBlocksOptions, signal?: AbortSignal): Promise<EvmBatch> {
  const { estimate } = options;
  const inFlight: Array<Promise<{ batch: EvmBatch; bytes: number; blocks: number }>> = [];
  let next = query.fromBlock;
  const schedule = () => {
    while (inFlight.length < CONCURRENCY && next < query.toBlock) {
      const span = estimate.bytesPerBlock > 0 ? Math.max(1, Math.floor(RESPONSE_BYTES_TARGET / estimate.bytesPerBlock)) : 1;
      const from = next;
      const to = Math.min(from + span, query.toBlock);
      const request = readRange(hsQuery, match, options, from, to, signal).then((r) => ({ ...r, blocks: to - from }));
      request.catch(() => {});
      inFlight.push(request);
      next = to;
    }
  };
  schedule();
  let merged: EvmBatch | undefined;
  for (let request = inFlight.shift(); request; request = inFlight.shift()) {
    const { batch, bytes, blocks } = await request;
    estimate.bytesPerBlock = bytes / blocks;
    merged = merged ? concatBatches(merged, batch) : batch;
    schedule();
  }
  if (!merged) throw new Error(`hypersync ${options.url}: empty whole-blocks range ${query.fromBlock}..${query.toBlock}`);
  return merged;
}

/** `from..to` matched, in as many responses as the server splits it into. */
async function readRange(hsQuery: Query, match: EvmMatcher, options: ArrowWholeBlocksOptions, from: number, to: number, signal?: AbortSignal): Promise<{ batch: EvmBatch; bytes: number }> {
  let batch: EvmBatch | undefined;
  let bytes = 0;
  for (let at = from; at < to; ) {
    const { response, size } = await readAdvancing(hsQuery, options, at, to, signal);
    const nextBlock = Math.min(Number(response.nextBlock), to);
    const matched = match(filterResponse(response, match, at, nextBlock));
    batch = batch ? concatBatches(batch, matched) : matched;
    bytes += size;
    at = nextBlock;
  }
  if (!batch) throw new Error(`hypersync ${options.url}: empty whole-blocks range ${from}..${to}`);
  return { batch, bytes };
}

/** Near the head, a server behind the reported height can answer without advancing: ask again before giving up. */
async function readAdvancing(hsQuery: Query, options: ArrowWholeBlocksOptions, from: number, to: number, signal?: AbortSignal): Promise<{ response: ArrowResponse; size: number }> {
  for (let attempt = 1; ; attempt++) {
    const body = await post(options, JSON.stringify(jsonQuery(hsQuery, from, to)), signal);
    const response = readResponse(body);
    if (response.nextBlock > from) return { response, size: body.length };
    if (attempt === 5) throw new Error(`hypersync ${options.url}: nextBlock ${response.nextBlock} did not advance from ${from}`);
    await sleep(1000 * attempt);
  }
}

/** Two contiguous matched batches as one: the first one's start and rollback guard parent, the second one's end. */
function concatBatches(a: EvmBatch, b: EvmBatch): EvmBatch {
  const batch: EvmBatch = { fromBlock: a.fromBlock, nextBlock: b.nextBlock, blocks: a.blocks, transactions: a.transactions, logs: a.logs, traces: a.traces ?? [], archiveHeight: b.archiveHeight };
  append(batch.blocks, b.blocks);
  append(batch.transactions, b.transactions);
  append(batch.logs, b.logs);
  append(batch.traces ?? [], b.traces ?? []);
  const first = a.rollbackGuard ?? b.rollbackGuard;
  const last = b.rollbackGuard ?? a.rollbackGuard;
  if (first && last) batch.rollbackGuard = { blockNumber: last.blockNumber, hash: last.hash, firstBlockNumber: first.firstBlockNumber, firstParentHash: first.firstParentHash };
  return batch;
}

/** The client's query as HyperSync's JSON API takes it: snake_case keys and field names. */
function jsonQuery(q: Query, from: number, to: number) {
  const snake = (field: string) => field.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase();
  const { block = [], log = [], transaction = [], trace = [] } = q.fieldSelection;
  return {
    from_block: from,
    to_block: to,
    logs: q.logs,
    transactions: q.transactions,
    traces: q.traces,
    field_selection: { block: block.map(snake), log: log.map(snake), transaction: transaction.map(snake), trace: trace.map(snake) },
  };
}

/**
 * Until when each API token is rate limited, shared by every chain: the limit is the token's, whatever the endpoint.
 * Like the client: a response with no requests left (`x-ratelimit-remaining: 0`) or a 429 makes every request wait
 * `x-ratelimit-reset` seconds before it is sent.
 */
const rateLimitedUntil = new Map<string, number>();

/**
 * One request, with the client's retries: any failure is tried again `maxNumRetries` times, 200 ms apart growing by
 * 500 ms up to 5 s, plus jitter. A 429 waits the window out (reset + 1 s) without spending an attempt.
 */
async function post(options: ArrowWholeBlocksOptions, body: string, signal: AbortSignal | undefined): Promise<Uint8Array> {
  let backoffMs = 200;
  for (let attempt = 0, limited = 0; ; attempt++) {
    const waitMs = (rateLimitedUntil.get(options.apiToken) ?? 0) - Date.now();
    if (waitMs > 0) await sleep(waitMs, undefined, { signal });
    signal?.throwIfAborted();
    options.onRequest();
    const timeout = AbortSignal.timeout(options.httpReqTimeoutMillis);
    const result = await send(options, body, signal ? AbortSignal.any([signal, timeout]) : timeout).catch((err: Error) => err);
    if (result instanceof Uint8Array) return result;
    if (result instanceof RateLimited && limited++ < 120) {
      attempt--;
      continue;
    }
    if (signal?.aborted || attempt >= options.maxNumRetries) throw result;
    await sleep(backoffMs + Math.random() * 500, undefined, { signal });
    backoffMs = Math.min(backoffMs + 500, 5_000);
  }
}

class RateLimited extends Error {}

async function send(options: ArrowWholeBlocksOptions, body: string, signal: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(`${options.url}/query/arrow-ipc`, { method: "POST", headers: { authorization: `Bearer ${options.apiToken}`, "content-type": "application/json" }, body, signal });
  const resetS = Number(res.headers.get("x-ratelimit-reset") ?? 1);
  if (res.status === 429) {
    rateLimitedUntil.set(options.apiToken, Date.now() + (resetS + 1) * 1000);
    console.warn(`hypersync ${options.url}: rate limited, waiting ${resetS + 1}s`);
    await res.body?.cancel();
    throw new RateLimited(`hypersync ${options.url}: rate limited for ${resetS}s`);
  }
  if (res.headers.get("x-ratelimit-remaining") === "0") rateLimitedUntil.set(options.apiToken, Date.now() + resetS * 1000);
  if (!res.ok) throw new Error(`hypersync ${options.url}: ${res.status} ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}

// ------------------------------------------------------------ Cap'n Proto (hypersync_net_types.capnp QueryResponse)

interface ArrowResponse {
  nextBlock: bigint;
  archiveHeight: bigint;
  rollbackGuard: RollbackGuard | undefined;
  blocks: RecordBatch[];
  transactions: RecordBatch[];
  logs: RecordBatch[];
  traces: RecordBatch[];
}

interface CapnpStruct {
  at: number;
  dataWords: number;
  ptrWords: number;
}

function readResponse(packed: Uint8Array): ArrowResponse {
  const message = new CapnpMessage(unpack(packed));
  const root = message.root();
  const data = message.struct(root, 0);
  const guard = message.struct(root, 1);
  const table = (i: number) => {
    const ipc = data ? message.data(data, i) : undefined;
    return ipc && ipc.length > 0 ? [...RecordBatchReader.from(ipc)] : [];
  };
  return {
    archiveHeight: message.int64(root, 0),
    nextBlock: message.uint64(root, 1),
    rollbackGuard: guard && {
      hash: hex(message.data(guard, 0)),
      blockNumber: Number(message.uint64(guard, 0)),
      firstBlockNumber: Number(message.uint64(guard, 2)),
      firstParentHash: hex(message.data(guard, 1)),
    },
    blocks: table(0),
    transactions: table(1),
    logs: table(2),
    traces: table(3),
  };
}

function hex(bytes: Uint8Array | undefined): string {
  return bytes ? `0x${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex")}` : "";
}

/** Packed Cap'n Proto to the flat message: the unpacked size is counted from the tags first, then words are written once. */
function unpack(packed: Uint8Array): Uint8Array {
  let words = 0;
  for (let src = 0; src < packed.length; words++) {
    const tag = packed[src] ?? 0;
    if (tag === 0) {
      words += packed[src + 1] ?? 0;
      src += 2;
      continue;
    }
    src += 1 + popcount(tag);
    if (tag !== 0xff) continue;
    const literal = packed[src] ?? 0;
    words += literal;
    src += 1 + literal * 8;
  }
  const out = new Uint8Array(words * 8);
  for (let src = 0, o = 0; o < out.length; ) {
    const tag = packed[src++] ?? 0;
    if (tag === 0) {
      o += 8 * ((packed[src++] ?? 0) + 1);
      continue;
    }
    for (let bit = 0; bit < 8; bit++) if (tag & (1 << bit)) out[o + bit] = packed[src++] ?? 0;
    o += 8;
    if (tag !== 0xff) continue;
    const literal = (packed[src++] ?? 0) * 8;
    out.set(packed.subarray(src, src + literal), o);
    src += literal;
    o += literal;
  }
  return out;
}

function popcount(byte: number): number {
  let n = 0;
  for (let b = byte; b; b &= b - 1) n++;
  return n;
}

class CapnpMessage {
  private readonly view: DataView;
  private readonly starts: number[] = [];

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = this.view.getUint32(0, true) + 1;
    let at = Math.ceil((4 + 4 * count) / 8) * 8;
    for (let i = 0; i < count; i++) {
      this.starts.push(at);
      at += this.view.getUint32(4 + 4 * i, true) * 8;
    }
  }

  root(): CapnpStruct {
    const root = this.pointer(this.segment(0));
    if (root?.kind !== "struct") throw new Error("capnp: root is not a struct");
    return root;
  }

  struct(s: CapnpStruct, index: number): CapnpStruct | undefined {
    if (index >= s.ptrWords) return undefined;
    const p = this.pointer(s.at + s.dataWords * 8 + index * 8);
    return p?.kind === "struct" ? p : undefined;
  }

  data(s: CapnpStruct, index: number): Uint8Array | undefined {
    if (index >= s.ptrWords) return undefined;
    const p = this.pointer(s.at + s.dataWords * 8 + index * 8);
    return p?.kind === "list" ? this.bytes.subarray(p.at, p.at + p.count) : undefined;
  }

  uint64(s: CapnpStruct, word: number): bigint {
    return word < s.dataWords ? this.view.getBigUint64(s.at + word * 8, true) : 0n;
  }

  int64(s: CapnpStruct, word: number): bigint {
    return word < s.dataWords ? this.view.getBigInt64(s.at + word * 8, true) : 0n;
  }

  private segment(id: number): number {
    const start = this.starts[id];
    if (start === undefined) throw new Error(`capnp: no segment ${id}`);
    return start;
  }

  private pointer(at: number): (CapnpStruct & { kind: "struct" }) | { kind: "list"; at: number; count: number } | undefined {
    const lo = this.view.getUint32(at, true);
    const hi = this.view.getUint32(at + 4, true);
    if (lo === 0 && hi === 0) return undefined;
    if ((lo & 3) !== 2) return this.decode(at, at + 8 + ((lo | 0) >> 2) * 8);
    const pad = this.segment(hi) + (lo >>> 3) * 8;
    if (((lo >>> 2) & 1) === 0) return this.pointer(pad);
    const content = this.segment(this.view.getUint32(pad + 4, true)) + (this.view.getUint32(pad, true) >>> 3) * 8;
    return this.decode(pad + 8, content);
  }

  private decode(at: number, content: number) {
    const lo = this.view.getUint32(at, true);
    const hi = this.view.getUint32(at + 4, true);
    if ((lo & 3) === 0) return { kind: "struct" as const, at: content, dataWords: hi & 0xffff, ptrWords: hi >>> 16 };
    if ((lo & 3) === 1) return { kind: "list" as const, at: content, count: hi >>> 3 };
    throw new Error(`capnp: pointer kind ${lo & 3}`);
  }
}

// ------------------------------------------------------------ Column filtering

/**
 * A Set of lowercase hex values probed with raw bytes: a value's last 4 bytes first, in an open-addressing table of
 * them (no allocation, ~10 bytes a value), the hex string only when that hits, so a non-matching row never becomes a
 * string.
 */
class ByteSet {
  private readonly tails: Uint32Array;
  private readonly mask: number;

  private constructor(readonly values: Set<string>) {
    this.tails = new Uint32Array(2 ** Math.ceil(Math.log2(values.size * 2 + 2)));
    this.mask = this.tails.length - 1;
    for (const v of values) this.add(Number.parseInt(v.slice(-8), 16) >>> 0);
  }

  private static readonly known = new WeakMap<Set<string>, ByteSet>();

  static of(values: Set<string>): ByteSet {
    const known = ByteSet.known.get(values);
    if (known) return known;
    const set = new ByteSet(values);
    ByteSet.known.set(values, set);
    return set;
  }

  hasTail(tail: number): boolean {
    for (let i = Math.imul(tail, 0x9e3779b1) & this.mask; ; i = (i + 1) & this.mask) {
      const slot = this.tails[i];
      if (slot === 0 || slot === undefined) return false;
      if (slot === (tail | 1) >>> 0) return true;
    }
  }

  private add(tail: number): void {
    let i = Math.imul(tail, 0x9e3779b1) & this.mask;
    while (this.tails[i] !== 0) i = (i + 1) & this.mask;
    this.tails[i] = (tail | 1) >>> 0;
  }
}

const byteSet = (values: Set<string>) => ByteSet.of(values);

class BinaryColumn {
  private readonly values: Buffer;
  private readonly offsets: DataView;

  constructor(private readonly data: Data) {
    const values = data.values instanceof Uint8Array ? data.values : new Uint8Array();
    this.values = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
    const offsets = data.valueOffsets instanceof Int32Array ? data.valueOffsets : new Int32Array(1);
    this.offsets = new DataView(offsets.buffer, offsets.byteOffset, offsets.byteLength);
  }

  static of(batch: RecordBatch, name: string): BinaryColumn | undefined {
    const data = batch.getChild(name)?.data[0];
    return data && new BinaryColumn(data);
  }

  valid(row: number): boolean {
    return this.data.getValid(row);
  }

  has(set: ByteSet, row: number): boolean {
    if (!this.data.getValid(row)) return false;
    const end = this.offsets.getInt32((row + 1) * 4, true);
    if (end - this.offsets.getInt32(row * 4, true) < 4) return false;
    return set.hasTail(this.values.readUInt32BE(end - 4)) && set.values.has(this.hex(row));
  }

  hex(row: number): string {
    return `0x${this.values.toString("hex", this.offsets.getInt32(row * 4, true), this.offsets.getInt32((row + 1) * 4, true))}`;
  }
}

function addressHits(sets: AddressSets, from: BinaryColumn | undefined, to: BinaryColumn | undefined, row: number): boolean {
  if (sets.any) return true;
  if (from?.has(byteSet(sets.senders), row) || to?.has(byteSet(sets.recipients), row)) return true;
  return sets.pairs.some((p) => from?.has(byteSet(p.from), row) === true && to?.has(byteSet(p.to), row) === true);
}

function logHits(sets: LogSets, address: BinaryColumn | undefined, topics: Array<BinaryColumn | undefined>, row: number): boolean {
  if (sets.any) return true;
  if (address?.has(byteSet(sets.addresses), row)) return true;
  if (sets.topics.some((set, i) => set.size > 0 && topics[i]?.has(byteSet(set), row) === true)) return true;
  return sets.rest.some((f) => (!f.address || address?.has(byteSet(f.address), row) === true) && f.topics.every((set, i) => !set || topics[i]?.has(byteSet(set), row) === true));
}

/**
 * The rows of a whole-blocks response `match` can select, as items: the transactions it takes whole (`join`) found
 * first from the three tables' columns, then every row of those transactions and every row a filter selects on its
 * own. Exactly what `match` keeps, so matching the result changes nothing.
 */
function filterResponse(response: ArrowResponse, match: EvmMatcher, fromBlock: number, nextBlock: number): EvmBatch {
  const { join, includeLogTransactions } = match.query;
  const logs = response.logs.map((batch) => ({ batch, cells: new Cells(batch), address: BinaryColumn.of(batch, "address"), tx: BinaryColumn.of(batch, "transaction_hash"), topics: [0, 1, 2, 3].map((i) => BinaryColumn.of(batch, `topic${i}`)) }));
  const transactions = response.transactions.map((batch) => ({ batch, cells: new Cells(batch), hash: BinaryColumn.of(batch, "hash"), from: BinaryColumn.of(batch, "from"), to: BinaryColumn.of(batch, "to") }));
  const traces = response.traces.map((batch) => ({ batch, cells: new Cells(batch), tx: BinaryColumn.of(batch, "transaction_hash"), from: BinaryColumn.of(batch, "from"), to: BinaryColumn.of(batch, "to") }));

  const whole = new Set<string>();
  if (join) {
    for (const t of transactions) for (let i = 0; i < t.batch.numRows; i++) if (addressHits(match.transactions, t.from, t.to, i) && t.hash) whole.add(t.hash.hex(i));
    for (const l of logs) for (let i = 0; i < l.batch.numRows; i++) if (logHits(match.joinLogs, l.address, l.topics, i) && l.tx) whole.add(l.tx.hex(i));
    for (const t of traces) for (let i = 0; i < t.batch.numRows; i++) if (addressHits(match.traces, t.from, t.to, i) && t.tx) whole.add(t.tx.hex(i));
  }
  const wholeBytes = byteSet(whole);
  const ofLogs = new Set<string>();
  const out: EvmBatch = { fromBlock, nextBlock, blocks: response.blocks.flatMap((batch) => Array.from({ length: batch.numRows }, (_, i) => toBlock(new Cells(batch), i))), transactions: [], logs: [], traces: [], archiveHeight: response.archiveHeight < 0n ? undefined : Number(response.archiveHeight) };
  for (const l of logs) {
    for (let i = 0; i < l.batch.numRows; i++) {
      const plain = logHits(match.logs, l.address, l.topics, i);
      if (!plain && !(whole.size > 0 && l.tx?.has(wholeBytes, i))) continue;
      const log = toLog(l.cells, i);
      out.logs.push(log);
      if (plain && includeLogTransactions) ofLogs.add(log.transactionHash);
    }
  }
  const ofLogsBytes = byteSet(ofLogs);
  for (const t of transactions) {
    for (let i = 0; i < t.batch.numRows; i++) {
      const taken = (whole.size > 0 && t.hash?.has(wholeBytes, i)) || (ofLogs.size > 0 && t.hash?.has(ofLogsBytes, i)) || addressHits(match.transactions, t.from, t.to, i);
      if (taken) out.transactions.push(toTransaction(t.cells, i));
    }
  }
  for (const t of traces) {
    for (let i = 0; i < t.batch.numRows; i++) {
      if ((whole.size > 0 && t.tx?.has(wholeBytes, i)) || addressHits(match.traces, t.from, t.to, i)) out.traces?.push(toTrace(t.cells, i));
    }
  }
  if (response.rollbackGuard) out.rollbackGuard = response.rollbackGuard;
  return out;
}

// ------------------------------------------------------------ Rows, the way the napi client and hypersync.ts map them

/** A record batch's cells by column name, the columns looked up once. */
class Cells {
  private readonly columns = new Map<string, { get(row: number): unknown } | null>();
  private readonly binaries = new Map<string, BinaryColumn | undefined>();

  constructor(private readonly batch: RecordBatch) {}

  get(name: string, row: number): unknown {
    let column = this.columns.get(name);
    if (column === undefined) {
      column = this.batch.getChild(name);
      this.columns.set(name, column);
    }
    return column?.get(row) ?? undefined;
  }

  hex(name: string, row: number): string | undefined {
    let column = this.binaries.get(name);
    if (!this.binaries.has(name)) {
      column = BinaryColumn.of(this.batch, name);
      this.binaries.set(name, column);
    }
    return column?.valid(row) ? column.hex(row) : undefined;
  }

  quantity(name: string, row: number): bigint | undefined {
    const value = this.hex(name, row);
    if (value === undefined) return undefined;
    return value === "0x" ? 0n : BigInt(value);
  }

  integer(name: string, row: number): number | undefined {
    const value = this.get(name, row);
    return typeof value === "bigint" || typeof value === "number" ? Number(value) : undefined;
  }

  text(name: string, row: number): string | undefined {
    const value = this.get(name, row);
    return typeof value === "string" ? value : undefined;
  }
}

function toBlock(c: Cells, row: number): EvmBlock {
  return { number: c.integer("number", row) ?? 0, hash: c.hex("hash", row) ?? "", parentHash: c.hex("parent_hash", row), timestamp: Number(c.quantity("timestamp", row) ?? 0n) };
}

function toLog(c: Cells, row: number): EvmLog {
  const removed = c.get("removed", row);
  return {
    blockNumber: c.integer("block_number", row) ?? 0,
    blockHash: c.hex("block_hash", row),
    transactionHash: c.hex("transaction_hash", row) ?? "",
    transactionIndex: c.integer("transaction_index", row) ?? 0,
    logIndex: c.integer("log_index", row) ?? 0,
    address: c.hex("address", row) ?? "",
    data: c.hex("data", row) ?? "0x",
    topics: [0, 1, 2, 3].flatMap((i) => c.hex(`topic${i}`, row) ?? []),
    removed: typeof removed === "boolean" ? removed : undefined,
  };
}

function toTransaction(c: Cells, row: number): EvmTransaction {
  return {
    hash: c.hex("hash", row) ?? "",
    blockNumber: c.integer("block_number", row) ?? 0,
    transactionIndex: c.integer("transaction_index", row) ?? 0,
    from: c.hex("from", row) ?? "",
    to: c.hex("to", row) || null,
    value: c.quantity("value", row) ?? 0n,
    input: c.hex("input", row) ?? "0x",
    nonce: c.quantity("nonce", row),
    gas: c.quantity("gas", row),
    gasPrice: c.quantity("gas_price", row),
    gasUsed: c.quantity("gas_used", row),
    effectiveGasPrice: c.quantity("effective_gas_price", row),
    l1Fee: c.quantity("l1_fee", row),
    status: c.integer("status", row),
    type: c.integer("type", row),
    contractAddress: c.hex("contract_address", row) ?? null,
  };
}

function toTrace(c: Cells, row: number): EvmTrace {
  return {
    transactionHash: c.hex("transaction_hash", row) ?? "",
    blockNumber: c.integer("block_number", row) ?? 0,
    traceAddress: traceAddress(c.get("trace_address", row)),
    type: c.text("type", row) ?? "call",
    callType: c.text("call_type", row),
    from: c.hex("from", row) ?? "",
    to: c.hex("to", row) || null,
    value: c.quantity("value", row) ?? 0n,
    error: c.text("error", row),
  };
}

/** bincode `Vec<u64>`: a little-endian u64 length, then the elements. */
function traceAddress(bytes: unknown): number[] {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: Number(view.getBigUint64(0, true)) }, (_, i) => Number(view.getBigUint64(8 + 8 * i, true)));
}
