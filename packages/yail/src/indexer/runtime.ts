import type { AddressRegistry } from "../addresses/registry.js";
import type { Db } from "../db/client.js";
import { BatchWriter } from "../db/batch.js";
import { blockHashes, checkpoints } from "../db/internal.js";
import { sql } from "../db/sql.js";
import type { RowMeta } from "../db/serialize.js";
import type { HttpClient } from "../http/client.js";
import { createCachedClient, type CachedClient } from "../rpc/cached-client.js";
import type { Observability, WideLogger } from "../observability/logger.js";
import { createError } from "evlog";
import type { BitcoinBatch, StellarBatch, EvmBatch, EvmBlock, EvmLog, EvmQuery, EvmSource, EvmTrace, EvmTransaction, SolanaBalance, SolanaBatch, SolanaBlock, SolanaInstruction, SolanaLog, SolanaTransaction, Source } from "../sources/types.js";
import { logOrder } from "../sources/types.js";
import { evmMatcher, matchEvmBatches, wholeBlocksQuery, type EvmMatcher } from "../sources/match.js";
import { isAddressSet, isFactory } from "../config/address.js";
import type { Config } from "../config/types.js";
import { createContext, type ContextDeps, type HandlerContext } from "./context.js";
import { CacheRunner } from "../cache/cached.js";
import { memory } from "../cache/stores.js";
import { bitcoinAccountEvent, decodeLog, directionOf, involvedAddresses, logMatchesFilter, solanaAccountEvent, stellarAccountEvent, type ContractEvent, type EvmAccountEvent, type BitcoinAccountEvent, type SetupEvent, type SolanaAccountEvent, type StellarAccountEvent, type SolanaInstructionEvent, type SolanaProgramEvent } from "./events.js";
import { activeIn, buildAddressQuery, buildEvmQuery, buildSolanaQuery, nextBoundary, resolveAddresses, type ChainPlan, type ContractSource, type ProgramSource, type QueryBuildOptions } from "./plan.js";
import { append, chunkList, toArray } from "../util.js";
import type { BackfillAddressPayload } from "./jobs.js";
import { decode, type Codec } from "../solana/codec.js";
import { EMIT_CPI_TAG, programData } from "../solana/program.js";
import { compareAddress } from "../sources/solana/shared.js";

export type Handler = (args: { event: any; context: HandlerContext<any, any> }) => Promise<void> | void;
export type Prefetcher = (args: { events: any[]; context: HandlerContext<any, any> }) => Promise<void> | void;

export interface RuntimeDeps {
  config: Config;
  db: Db;
  registry: AddressRegistry;
  obs: Observability;
  http: HttpClient;
  handlers: Map<string, Handler[]>;
  /** Called once per batch with every event of a name, before its handlers run (`indexer.prefetch`). */
  prefetchers: Map<string, Prefetcher[]>;
  contracts: ContextDeps["contracts"];
  /** Called by the live loop when newly adopted addresses need history. */
  enqueueBackfill: (chain: string, job: BackfillAddressPayload) => Promise<void>;
  /** Called on a detected reorg to re-index a window. */
  enqueueReindex: (chain: string, fromBlock: number, toBlock: number) => Promise<void>;
  onError?: "stop" | "skip";
}

type DispatchPayload =
  | { kind: "contract"; payload: ContractEvent }
  | { kind: "evmAccount"; payload: EvmAccountEvent }
  | { kind: "bitcoinAccount"; payload: BitcoinAccountEvent }
  | { kind: "solanaAccount"; payload: SolanaAccountEvent }
  | { kind: "stellarAccount"; payload: StellarAccountEvent }
  | { kind: "solanaInstruction"; payload: SolanaInstructionEvent }
  | { kind: "solanaProgram"; payload: SolanaProgramEvent };

type DispatchEvent = { block: number; txIndex: number; logIndex: number; name: string } & DispatchPayload;

/** A program event of one transaction, before ranking: by `position`, an instruction before the log lines it wrote. */
interface ProgramHit {
  position: number[];
  isLogLine: boolean;
  name: string;
  event: Extract<DispatchPayload, { kind: "solanaInstruction" | "solanaProgram" }>;
}

/** What every program event of one transaction shares. */
interface TransactionContext {
  transaction: SolanaTransaction;
  block: SolanaBlock;
  balances: SolanaBalance[];
}

/** Thrown by `step` when the loop is done (`once`, or past `endBlock`). */
class StopLoop extends Error {}

export class ReorgError extends Error {
  constructor(public readonly chain: string, public readonly atBlock: number) {
    super(`reorg detected on ${chain} around block ${atBlock}`);
  }
}

export interface ProcessRangeOptions {
  override?: QueryBuildOptions["override"];
  backfill: boolean;
  signal?: AbortSignal;
  label?: string;
  /** Where the range is read from. Default: the chain's `source`. */
  source?: Source;
  /** Called once each batch is written, with the first block after it. */
  onProgress?: (nextBlock: number) => Promise<void>;
}

export class ChainRunner {
  cursor = 0;
  head = 0;
  finalized = -1;
  running = false;
  caughtUp = false;
  error: Error | undefined;
  readonly abort = new AbortController();
  readonly client: CachedClient | undefined;
  readonly finality: number;
  readonly pollInterval: number;
  readonly maxBlockRange: number;
  readonly wholeBlocksWithin: number | undefined;
  private wakeResolve: (() => void) | undefined;
  private lastRefresh = 0;

  constructor(
    readonly deps: RuntimeDeps,
    readonly plan: ChainPlan,
  ) {
    const cfg = plan.config;
    const defaults = chainDefaults(plan);
    this.finality = cfg.finality ?? defaults.finality;
    this.pollInterval = cfg.pollInterval ?? defaults.pollInterval;
    this.maxBlockRange = cfg.maxBlockRange ?? defaults.maxBlockRange;
    this.wholeBlocksWithin = cfg.wholeBlocksWithin;
    if (plan.kind === "evm" && cfg.rpc) {
      this.client = createCachedClient({
        chain: plan.chain,
        url: cfg.rpc,
        db: deps.db,
        persist: deps.config.cache?.rpc !== false,
        onCache: (hit) => deps.obs.metrics.recordCache("rpc", hit),
        currentBlock: () => this.currentBlock,
      });
    }
  }

  private currentBlock: number | undefined;

  get chain(): string {
    return this.plan.chain;
  }

  async init(): Promise<void> {
    const rows = await this.deps.db.rows(checkpoints, sql`WHERE chain = ${this.chain} LIMIT 1`);
    const cp = rows[0];
    this.cursor = this.plan.startBlock;
    this.head = 0;
    if (cp) {
      this.cursor = Math.max(Number(cp.cursor), this.plan.startBlock);
      this.head = Number(cp.head);
    }
    // Seed configured address sets.
    for (const [set, def] of Object.entries(this.deps.config.addressSets ?? {})) {
      if (!this.plan.sets.has(set)) continue;
      for (const item of def.initial ?? []) {
        const spec = typeof item === "string" ? { address: item } : item;
        if (spec.chain && spec.chain !== this.chain) continue;
        await this.deps.registry.register({ set, chain: this.chain, address: spec.address, fromBlock: spec.fromBlock ?? this.plan.sets.get(set) ?? 0 });
      }
    }
    await this.runSetup();
  }

  private async runSetup(): Promise<void> {
    const handlers = this.deps.handlers.get("setup") ?? [];
    if (handlers.length === 0) return;
    const writer = new BatchWriter(this.deps.db);
    const meta = { current: { chain: this.chain, block: this.cursor, version: 0n } as RowMeta };
    const log = this.deps.obs.wide({ chain: this.chain, stage: "setup", block: this.cursor });
    const context = this.makeContext(writer, meta, log, false);
    const event: SetupEvent = { block: this.cursor };
    for (const h of handlers) await h({ event, context });
    await writer.flush();
    log.emit();
  }

  wake(): void {
    this.wakeResolve?.();
  }

  /** Live loop. With `once`, returns as soon as the chain is caught up to the finalized head. */
  async runLoop(options: { once?: boolean } = {}): Promise<void> {
    this.running = true;
    const { metrics, log } = this.deps.obs;
    let failures = 0;
    try {
      while (this.running && !this.abort.signal.aborted) {
        // A source outage must not take the chain down: back off and resume from the checkpoint, up to ~30 minutes.
        try {
          await this.step(options);
          failures = 0;
        } catch (err) {
          if (this.abort.signal.aborted || err instanceof StopLoop || ++failures > 30) throw err;
          const wait = Math.min(60_000, 1000 * 2 ** failures);
          log.error({ event: "chain_retry", chain: this.chain, cursor: this.cursor, attempt: failures, waitMs: wait, error: { name: (err as Error).name, message: (err as Error).message } });
          metrics.recordError(this.chain, "source");
          await this.sleep(wait);
        }
      }
    } catch (err) {
      if (err instanceof StopLoop) return;
      this.error = err as Error;
      metrics.recordError(this.chain, "chain");
      log.error({ event: "chain_failed", chain: this.chain, cursor: this.cursor, error: { name: (err as Error).name, message: (err as Error).message, stack: (err as Error).stack } });
      throw err;
    } finally {
      this.running = false;
    }
  }

  /** One turn of the loop: refresh the head, then index the next range or wait at the tip. */
  private async step(options: { once?: boolean }): Promise<void> {
    const { metrics, log } = this.deps.obs;
    this.head = await this.plan.config.source.getHeight();
    this.finalized = this.head - this.finality;
    if (this.plan.endBlock !== undefined) this.finalized = Math.min(this.finalized, this.plan.endBlock);
    await this.maybeRefreshRegistry();
    await this.adoptPending();
    metrics.setProgress(this.chain, this.cursor, this.head, this.finalized);
    if (this.cursor > this.finalized) {
      if (!this.caughtUp) {
        this.caughtUp = true;
        log.info("yail", `${this.chain}: caught up at block ${this.cursor - 1} (head ${this.head}, finality ${this.finality})`);
      }
      if (options.once || (this.plan.endBlock !== undefined && this.cursor > this.plan.endBlock)) throw new StopLoop();
      await this.sleep(this.pollInterval);
      return;
    }
    this.caughtUp = false;
    let to = Math.min(this.finalized + 1, this.cursor + this.maxBlockRange);
    const boundary = nextBoundary(this.plan, this.cursor);
    if (boundary !== undefined) to = Math.min(to, boundary);
    try {
      await this.processRange(this.cursor, to, { backfill: false, signal: this.abort.signal, label: "live" });
    } catch (err) {
      if (err instanceof ReorgError) {
        const from = Math.max(this.plan.startBlock, err.atBlock - this.finality * 2);
        log.error({ event: "reorg", chain: this.chain, atBlock: err.atBlock, rewindTo: from });
        metrics.recordError(this.chain, "reorg");
        await this.deps.enqueueReindex(this.chain, from, this.cursor);
        return;
      }
      throw err;
    }
  }

  stop(): void {
    this.running = false;
    this.abort.abort();
    this.wake();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wakeResolve = undefined;
        resolve();
      }, ms);
      this.wakeResolve = () => {
        clearTimeout(t);
        this.wakeResolve = undefined;
        resolve();
      };
    });
  }

  private async maybeRefreshRegistry(): Promise<void> {
    // Pick up addresses registered by other processes (CLI, API) via the database.
    const now = Date.now();
    if (now - this.lastRefresh < 10_000) return;
    this.lastRefresh = now;
    await this.deps.registry.load();
  }

  /**
   * Adopt newly registered addresses at the current cursor and schedule their history. A failed address registered
   * again keeps the block it was first adopted at: the live loop has indexed it since.
   */
  private async adoptPending(): Promise<void> {
    const pending = this.deps.registry.unadopted(this.chain);
    if (pending.length === 0) return;
    const at = BigInt(this.cursor);
    const adopted = pending.map((r) => ({ ...r, adoptedAtBlock: r.adoptedAtBlock > 0n ? r.adoptedAtBlock : at }));
    const needBackfill = adopted.filter((r) => r.fromBlock < r.adoptedAtBlock);
    const liveNow = adopted.filter((r) => r.fromBlock >= r.adoptedAtBlock);
    await this.deps.registry.updateMany(needBackfill, { adopted: true, status: "pending" });
    await this.deps.registry.updateMany(liveNow, { adopted: true, status: "live" });
    const backfills = new Map<string, BackfillAddressPayload>();
    for (const r of needBackfill) {
      const key = `${r.set}:${r.fromBlock}:${r.adoptedAtBlock}`;
      const job = backfills.get(key) ?? { set: r.set, addresses: [], fromBlock: Number(r.fromBlock), toBlock: Number(r.adoptedAtBlock) };
      job.addresses.push(r.address);
      backfills.set(key, job);
    }
    // A Stellar job reads every ledger of its range whatever its addresses: one job per range.
    const batchSize = this.plan.kind === "stellar" ? Infinity : (this.deps.config.indexing?.backfillBatch ?? 500);
    for (const job of backfills.values()) {
      for (const addresses of chunkList(job.addresses, batchSize)) await this.deps.enqueueBackfill(this.chain, { ...job, addresses });
    }
    this.deps.obs.log.info({ event: "addresses_adopted", chain: this.chain, atBlock: this.cursor, live: liveNow.length, backfill: needBackfill.length });
  }

  /**
   * Fetch + process a block range. In live mode this advances the cursor and
   * writes checkpoints after every batch; in backfill mode it only writes data.
   */
  async processRange(from: number, to: number, options: ProcessRangeOptions): Promise<{ batches: number; events: number }> {
    const { metrics, log } = this.deps.obs;
    const stats = { batches: 0, events: 0 };
    if (from >= to) return stats;
    const source = options.source ?? this.plan.config.source;
    const addressChunk = this.deps.config.indexing?.addressChunk ?? 500;
    const flushMaxRows = this.deps.config.indexing?.flushMaxRows ?? 50_000;
    const live = !options.backfill;

    let fetchBatches: () => AsyncIterable<EvmBatch | BitcoinBatch | SolanaBatch | StellarBatch>;
    let empty: boolean;
    if (source.kind === "evm") {
      const atHead = this.nearHead(live, from) && !options.override ? this.headQuery(from, to, addressChunk) : undefined;
      const q = atHead?.query ?? buildEvmQuery(this.plan, from, to, this.deps.registry, { override: options.override, addressChunk });
      fetchBatches = () => source.fetch(q, { signal: options.signal });
      // Matched with the registry of each batch: a factory child registered by one batch is matched in the next.
      if (atHead) fetchBatches = () => matchEvmBatches(source.fetch(wholeBlocksQuery(q), { signal: options.signal, match: atHead.match }), (batch) => this.headQuery(batch.fromBlock, batch.nextBlock, addressChunk).match(batch));
      empty = q.logs.length === 0 && q.transactions.length === 0;
    } else if (source.kind === "solana") {
      const q = buildSolanaQuery(this.plan, from, to, this.deps.registry, { override: options.override });
      fetchBatches = () => source.fetch(q, { signal: options.signal });
      empty = q.addresses.length + q.instructions.length + q.logs.length === 0;
    } else if (source.kind === "stellar") {
      const q = buildAddressQuery(this.plan, from, to, this.deps.registry, { override: options.override });
      fetchBatches = () => source.fetch(q, { signal: options.signal });
      empty = q.addresses.length === 0;
    } else {
      const q = buildAddressQuery(this.plan, from, to, this.deps.registry, { override: options.override });
      fetchBatches = () => source.fetch({ ...q, wholeBlocks: this.nearHead(live, from) }, { signal: options.signal });
      empty = q.addresses.length === 0;
    }
    if (empty) {
      if (live) await this.advance(to);
      return stats;
    }

    let batchFrom = from;
    let sourceStart = performance.now();
    const iterator = fetchBatches()[Symbol.asyncIterator]();
    for (;;) {
      const next = await iterator.next();
      const sourceMs = performance.now() - sourceStart;
      if (next.done) break;
      const batch = next.value;
      const started = performance.now();
      const wide = this.deps.obs.wide({ chain: this.chain, mode: options.label ?? (live ? "live" : "backfill"), fromBlock: batch.fromBlock, toBlock: batch.nextBlock - 1 });
      const writer = new BatchWriter(this.deps.db, { maxRows: flushMaxRows, onFlush: (s) => metrics.recordFlush(s.table, s.rows, s.ms) });
      const meta = { current: { chain: this.chain, block: batch.fromBlock, version: 0n } as RowMeta };
      const context = this.makeContext(writer, meta, wide, options.backfill);
      let eventCount = 0;
      try {
        await metrics.span("yail.batch", { chain: this.chain, fromBlock: batch.fromBlock, toBlock: batch.nextBlock }, async () => {
          if (this.plan.kind === "evm") {
            const evmBatch = batch as EvmBatch;
            if (live) this.checkReorg(evmBatch);
            if (live) await this.expandFactories(evmBatch, options.signal);
            eventCount = await this.dispatchEvm(evmBatch, context, meta, writer, options.override);
            if (live) await this.rememberHashes(evmBatch);
          } else if (this.plan.kind === "solana") {
            eventCount = await this.dispatchSolana(batch as SolanaBatch, context, meta, writer, options.override);
          } else if (this.plan.kind === "stellar") {
            eventCount = await this.dispatchStellar(batch as StellarBatch, context, meta, writer, options.override);
          } else {
            eventCount = await this.dispatchBitcoin(batch as BitcoinBatch, context, meta, writer, options.override);
          }
          await writer.flush();
          if (live) await this.advance(batch.nextBlock);
        });
      } catch (err) {
        writer.discard();
        wide.error(err as Error);
        wide.set({ events: eventCount });
        wide.emit();
        metrics.recordError(this.chain, live ? "batch" : "backfill");
        throw err;
      }
      const ms = performance.now() - started;
      stats.batches++;
      stats.events += eventCount;
      metrics.recordBatch(this.chain, batch.nextBlock - batch.fromBlock, eventCount, ms, sourceMs);
      wide.set({ events: eventCount, logs: (batch as EvmBatch).logs?.length ?? 0, transactions: batch.transactions.length, sourceMs: Math.round(sourceMs), processMs: Math.round(ms), rows: metrics.counters.rowsFlushed });
      if (this.deps.obs.config.batchEvents) wide.emit();
      batchFrom = batch.nextBlock;
      await options.onProgress?.(batchFrom);
      sourceStart = performance.now();
    }
    if (live && batchFrom < to) await this.advance(to);
    if (!live && batchFrom < to) {
      log.warn({ event: "range_incomplete", chain: this.chain, from, to, reached: batchFrom });
    }
    return stats;
  }

  /** Live ranges starting within `wholeBlocksWithin` of the head are read as whole blocks. */
  private nearHead(live: boolean, from: number): boolean {
    return live && this.wholeBlocksWithin !== undefined && this.head - from <= this.wholeBlocksWithin;
  }

  private headMatch: { key: string; query: EvmQuery; match: EvmMatcher } | undefined;

  /**
   * Near the head every poll filters whole blocks with the same query: it and its matcher are built again only when
   * the chain's addresses or the active sources change, so a poll costs what its blocks hold, not what the registry does.
   */
  private headQuery(from: number, to: number, addressChunk: number): { query: EvmQuery; match: EvmMatcher } {
    const active = [...this.plan.contracts, ...this.plan.accounts].filter((s) => activeIn(s, from, to)).map((s) => s.name);
    const key = `${this.deps.registry.version(this.chain)}:${active.join()}`;
    if (this.headMatch?.key !== key) {
      const query = buildEvmQuery(this.plan, from, to, this.deps.registry, { addressChunk });
      this.headMatch = { key, query, match: evmMatcher(query) };
    }
    return { query: { ...this.headMatch.query, fromBlock: from, toBlock: to }, match: this.headMatch.match };
  }

  private async advance(nextBlock: number): Promise<void> {
    this.cursor = nextBlock;
    await this.deps.db.insert(checkpoints).values({ chain: this.chain, cursor: BigInt(nextBlock), head: BigInt(this.head), updatedAt: new Date() });
    this.deps.obs.metrics.setProgress(this.chain, this.cursor, this.head, this.finalized);
  }

  private cache?: CacheRunner;

  private makeContext(writer: BatchWriter, meta: { current: RowMeta }, log: WideLogger, backfill: boolean): HandlerContext<any, string> {
    const chain = { name: this.chain, id: this.plan.config.id, kind: this.plan.kind };
    this.cache ??= new CacheRunner(this.deps.config.cache?.store ?? memory(), this.chain, (hit) => this.deps.obs.metrics.recordCache("cached", hit));
    return createContext({
      db: this.deps.db,
      writer,
      registry: this.deps.registry,
      http: this.deps.http,
      client: this.client,
      cache: this.cache,
      chain,
      contracts: this.deps.contracts,
      defaultFromBlock: (set) => this.plan.sets.get(set) ?? this.plan.startBlock,
      log,
      backfill,
      meta,
    });
  }

  // ------------------------------------------------------------ EVM

  private lastHashes = new Map<number, string>();

  private checkReorg(batch: EvmBatch): void {
    const guard = batch.rollbackGuard;
    if (!guard) return;
    const known = this.lastHashes.get(guard.firstBlockNumber - 1);
    if (known && guard.firstParentHash && known.toLowerCase() !== guard.firstParentHash.toLowerCase()) {
      throw new ReorgError(this.chain, guard.firstBlockNumber - 1);
    }
  }

  private async rememberHashes(batch: EvmBatch): Promise<void> {
    const last = batch.blocks.at(-1);
    if (!last) return;
    this.lastHashes.set(last.number, last.hash);
    for (const n of [...this.lastHashes.keys()]) if (n < last.number - this.finality * 4) this.lastHashes.delete(n);
    await this.deps.db.insert(blockHashes).values({ chain: this.chain, block: BigInt(last.number), hash: last.hash, createdAt: new Date() });
  }

  /** Discover factory children in this batch and pull their logs for the rest of the range. */
  private async expandFactories(batch: EvmBatch, signal?: AbortSignal): Promise<void> {
    const factories = this.plan.contracts.filter((c) => c.factory);
    if (factories.length === 0) return;
    for (const c of factories) {
      const f = c.factory!;
      const addrs = new Set(toArray(f.ref.address).map((a) => a.toLowerCase()));
      const discovered: Array<{ address: string; block: number }> = [];
      for (const log of batch.logs) {
        if (!addrs.has(log.address) || (log.topics[0] ?? "").toLowerCase() !== f.topic0) continue;
        const decoded = decodeLog(f.event, log);
        const child = decoded?.args[f.ref.parameter];
        if (typeof child !== "string") continue;
        const address = child.toLowerCase();
        if (this.deps.registry.has(f.set, this.chain, address)) continue;
        await this.deps.registry.register({ set: f.set, chain: this.chain, address, fromBlock: log.blockNumber, status: "live", adoptedAtBlock: log.blockNumber });
        discovered.push({ address, block: log.blockNumber });
      }
      if (discovered.length === 0 || c.events.length === 0) continue;
      const from = Math.min(...discovered.map((d) => d.block));
      const sub = buildEvmQuery(this.plan, from, batch.nextBlock, this.deps.registry, { override: { set: f.set, addresses: discovered.map((d) => d.address) } });
      if (sub.logs.length === 0) continue;
      const seen = new Set(batch.logs.map((l) => `${l.blockNumber}:${l.logIndex}`));
      const blocks = new Map(batch.blocks.map((b) => [b.number, b]));
      const txs = new Map(batch.transactions.map((t) => [t.hash, t]));
      for await (const extra of (this.plan.config.source as EvmSource).fetch(sub, { signal })) {
        for (const l of extra.logs) {
          const k = `${l.blockNumber}:${l.logIndex}`;
          if (!seen.has(k)) {
            seen.add(k);
            batch.logs.push(l);
          }
        }
        for (const b of extra.blocks) blocks.set(b.number, b);
        for (const t of extra.transactions) txs.set(t.hash, t);
      }
      batch.blocks = [...blocks.values()].sort((a, b) => a.number - b.number);
      batch.transactions = [...txs.values()];
      batch.logs.sort(logOrder);
      this.deps.obs.log.info({ event: "factory_children", chain: this.chain, contract: c.name, discovered: discovered.length, fromBlock: from });
    }
  }

  private contractMatches(c: ContractSource, log: EvmLog, override?: QueryBuildOptions["override"]): boolean {
    if (log.blockNumber < c.startBlock || (c.endBlock !== undefined && log.blockNumber > c.endBlock)) return false;
    const spec = c.address;
    if (spec === undefined) return true;
    if (typeof spec === "string") return spec.toLowerCase() === log.address;
    if (Array.isArray(spec)) return (spec as readonly string[]).some((a) => a.toLowerCase() === log.address);
    if (isAddressSet(spec)) {
      if (override && override.set === spec.set) return override.addresses.includes(log.address);
      return this.deps.registry.has(spec.set, this.chain, log.address);
    }
    if (isFactory(spec)) {
      const set = c.factory!.set;
      if (override && override.set === set) return override.addresses.includes(log.address);
      return this.deps.registry.has(set, this.chain, log.address);
    }
    return false;
  }

  private async dispatchEvm(batch: EvmBatch, context: HandlerContext<any, string>, meta: { current: RowMeta }, writer: BatchWriter, override?: QueryBuildOptions["override"]): Promise<number> {
    const blocks = new Map(batch.blocks.map((b) => [b.number, b]));
    const txs = new Map(batch.transactions.map((t) => [t.hash, t]));
    const events: DispatchEvent[] = [];
    const inSet = (set: string, address: string) => {
      if (override && override.set === set) return override.addresses.includes(address);
      return this.deps.registry.has(set, this.chain, address);
    };

    for (const log of batch.logs) {
      const topic0 = (log.topics[0] ?? "").toLowerCase();
      for (const c of this.plan.contracts) {
        const ev = c.events.find((e) => e.topic0 === topic0);
        if (!ev || !this.contractMatches(c, log, override)) continue;
        if (c.filters.length > 0) {
          const relevant = c.filters.filter((f) => f.topic0 === topic0);
          if (relevant.length > 0 && !relevant.some((f) => logMatchesFilter(log, f, inSet))) continue;
        }
        const name = `${c.name}:${ev.name}`;
        if (!this.deps.handlers.has(name)) continue;
        const decoded = decodeLog(ev.abi, log);
        if (!decoded) {
          this.deps.obs.log.warn({ event: "decode_failed", chain: this.chain, contract: c.name, eventName: ev.name, tx: log.transactionHash, logIndex: log.logIndex });
          continue;
        }
        const block = await this.blockOf(blocks, log.blockNumber);
        const payload: ContractEvent = { name: ev.name, args: decoded.args as any, address: log.address, log, block };
        if (c.includeTransactions) payload.transaction = txs.get(log.transactionHash);
        events.push({ block: log.blockNumber, txIndex: log.transactionIndex, logIndex: log.logIndex + 1, name, kind: "contract", payload });
      }
    }

    const logsOf = groupBy([...batch.logs].sort(logOrder), (l) => l.transactionHash);
    const tracesOf = groupBy(batch.traces ?? [], (t) => t.transactionHash);
    for (const a of this.plan.accounts) {
      const name = `${a.name}:transaction`;
      if (!this.deps.handlers.has(name)) continue;
      const resolved = resolveAddresses(a.address, this.chain, this.deps.registry, override);
      const members = new Set(resolved.addresses);
      for (const tx of batch.transactions) {
        if (tx.blockNumber < a.startBlock || (a.endBlock !== undefined && tx.blockNumber > a.endBlock)) continue;
        let logs: EvmLog[] = [];
        let traces: EvmTrace[] = [];
        if (a.activity) {
          logs = logsOf.get(tx.hash) ?? [];
          traces = tracesOf.get(tx.hash) ?? [];
        }
        const accounts = involvedAddresses(tx, logs, traces).filter((address) => members.has(address));
        if (accounts.length === 0) continue;
        const block = await this.blockOf(blocks, tx.blockNumber);
        for (const address of accounts) {
          const payload: EvmAccountEvent = { address, direction: directionOf(tx, address), transaction: tx, block, logs, traces };
          events.push({ block: tx.blockNumber, txIndex: tx.transactionIndex, logIndex: 0, name, kind: "evmAccount", payload });
        }
      }
    }

    return this.dispatch(events, context, meta, writer);
  }

  private async blockOf(blocks: Map<number, EvmBlock>, number: number): Promise<EvmBlock> {
    let b = blocks.get(number);
    if (b) return b;
    const src = this.plan.config.source as EvmSource;
    b = (await src.getBlock?.(number)) ?? undefined;
    if (!b) throw createError({ message: `block ${number} missing from ${src.name} response`, why: "The source returned logs without their block header", fix: "Check the source's field selection / fixture contents" });
    blocks.set(number, b);
    return b;
  }

  // ------------------------------------------------------------ Bitcoin

  private async dispatchBitcoin(batch: BitcoinBatch, context: HandlerContext<any, string>, meta: { current: RowMeta }, writer: BatchWriter, override?: QueryBuildOptions["override"]): Promise<number> {
    const events: DispatchEvent[] = [];
    for (const a of this.plan.accounts) {
      const name = `${a.name}:transaction`;
      if (!this.deps.handlers.has(name)) continue;
      const members = resolveAddresses(a.address, this.chain, this.deps.registry, override).addresses;
      const set = new Set(members);
      for (const tx of batch.transactions) {
        if (tx.blockHeight < a.startBlock || (a.endBlock !== undefined && tx.blockHeight > a.endBlock)) continue;
        const touched = new Set<string>();
        for (const i of tx.vin) if (i.prevout?.address && set.has(i.prevout.address)) touched.add(i.prevout.address);
        for (const o of tx.vout) if (o.address && set.has(o.address)) touched.add(o.address);
        let idx = 0;
        for (const address of touched) {
          const payload = bitcoinAccountEvent(tx, address);
          if (payload) events.push({ block: tx.blockHeight, txIndex: hashIndex(tx.txid), logIndex: idx++, name, kind: "bitcoinAccount", payload });
        }
      }
    }
    return this.dispatch(events, context, meta, writer);
  }

  // ------------------------------------------------------------ Stellar

  private async dispatchStellar(batch: StellarBatch, context: HandlerContext<any, string>, meta: { current: RowMeta }, writer: BatchWriter, override?: QueryBuildOptions["override"]): Promise<number> {
    const ledgers = new Map(batch.ledgers.map((l) => [l.sequence, l]));
    const eventsOf = groupBy(batch.events, (e) => e.transactionHash);
    const events: DispatchEvent[] = [];
    for (const a of this.plan.accounts) {
      const name = `${a.name}:transaction`;
      if (!this.deps.handlers.has(name)) continue;
      const members = resolveAddresses(a.address, this.chain, this.deps.registry, override).addresses;
      for (const tx of batch.transactions) {
        if (tx.ledger < a.startBlock || (a.endBlock !== undefined && tx.ledger > a.endBlock)) continue;
        const ledger = ledgers.get(tx.ledger);
        if (!ledger) throw createError({ message: `ledger ${tx.ledger} missing from ${this.plan.config.source.name} response`, why: "The source returned a transaction without its ledger", fix: "Check the source's batch contents" });
        const txEvents = eventsOf.get(tx.hash) ?? [];
        let idx = 0;
        for (const address of members) {
          const payload = stellarAccountEvent(tx, ledger, txEvents, address);
          if (payload) events.push({ block: tx.ledger, txIndex: tx.transactionIndex, logIndex: idx++, name, kind: "stellarAccount", payload });
        }
      }
    }
    return this.dispatch(events, context, meta, writer);
  }

  // ------------------------------------------------------------ Solana

  private async dispatchSolana(batch: SolanaBatch, context: HandlerContext<any, string>, meta: { current: RowMeta }, writer: BatchWriter, override?: QueryBuildOptions["override"]): Promise<number> {
    const blocks = new Map(batch.blocks.map((b) => [b.slot, b]));
    const blockOf = (slot: number): SolanaBlock => {
      const block = blocks.get(slot);
      if (!block) throw createError({ message: `slot ${slot} missing from ${this.plan.config.source.name} response`, why: "The source returned a transaction without its block", fix: "Check the source's field selection / fixture contents" });
      return block;
    };
    const balancesOf = groupBy(batch.balances, (b) => b.signature);
    const events: DispatchEvent[] = [];
    for (const a of this.plan.accounts) {
      const name = `${a.name}:transaction`;
      if (!this.deps.handlers.has(name)) continue;
      const members = resolveAddresses(a.address, this.chain, this.deps.registry, override).addresses;
      for (const tx of batch.transactions) {
        if (tx.slot < a.startBlock || (a.endBlock !== undefined && tx.slot > a.endBlock)) continue;
        const rows = balancesOf.get(tx.signature);
        if (!rows) continue;
        const block = blockOf(tx.slot);
        for (const address of members) {
          const payload = solanaAccountEvent(tx, block, rows, address);
          if (payload) events.push({ block: tx.slot, txIndex: tx.transactionIndex, logIndex: 0, name, kind: "solanaAccount", payload });
        }
      }
    }
    append(events, this.solanaProgramEvents(batch, blockOf));
    return this.dispatch(events, context, meta, writer);
  }

  /**
   * The program events of each transaction, ranked by address with an instruction before the log lines it wrote.
   * The rank orders them after the transaction's wallet events (rank 0) and feeds the rows' version.
   */
  private solanaProgramEvents(batch: SolanaBatch, blockOf: (slot: number) => SolanaBlock): DispatchEvent[] {
    if (this.plan.programs.length === 0) return [];
    const instructionsOf = groupBy(batch.instructions, (i) => i.signature);
    const logsOf = groupBy(batch.logs, (l) => l.signature);
    const balancesOf = groupBy(batch.joinedBalances, (b) => b.signature);
    const events: DispatchEvent[] = [];
    for (const transaction of batch.transactions) {
      const instructions = instructionsOf.get(transaction.signature) ?? [];
      const logs = logsOf.get(transaction.signature) ?? [];
      if (instructions.length + logs.length === 0) continue;
      const block = blockOf(transaction.slot);
      const hits: ProgramHit[] = [];
      for (const p of this.plan.programs) {
        if (transaction.slot < p.startBlock || (p.endBlock !== undefined && transaction.slot > p.endBlock)) continue;
        const balances = p.includeBalances ? (balancesOf.get(transaction.signature) ?? []) : [];
        const shared = { transaction, block, balances };
        hits.push(...this.instructionHits(p, instructions, logs, shared), ...this.emittedHits(p, instructions, logs, shared));
      }
      hits.sort((a, b) => compareAddress(a.position, b.position) || Number(a.isLogLine) - Number(b.isLogLine));
      hits.forEach((hit, rank) => events.push({ block: transaction.slot, txIndex: transaction.transactionIndex, logIndex: rank + 1, name: hit.name, ...hit.event }));
    }
    return events;
  }

  private instructionHits(p: ProgramSource, instructions: SolanaInstruction[], logs: SolanaLog[], shared: TransactionContext): ProgramHit[] {
    if (p.instructions.length === 0) return [];
    const matched = instructions.flatMap((instruction) => {
      if (!p.addresses.includes(instruction.program) || isEventCpi(instruction)) return [];
      const handled = p.instructions.find((i) => instruction.data.startsWith(i.def.discriminator));
      if (!handled) return [];
      return [{ instruction, handled }];
    });
    const hits: ProgramHit[] = [];
    for (const [program, list] of groupBy(matched, (m) => m.instruction.program)) {
      const programInstructions = list.map((m) => m.instruction);
      const programLogs = p.includeLogs ? logs.filter((l) => l.program === program) : [];
      for (const [ordinal, { instruction, handled }] of list.entries()) {
        const name = `${p.name}:${handled.name}`;
        const args = tryDecode(handled.def.args, Buffer.from(instruction.data.slice(handled.def.discriminator.length), "hex"));
        const accounts = bindAccounts(handled.def.accounts, instruction.accounts);
        if (!args || !accounts) {
          this.deps.obs.log.warn({ event: "decode_failed", chain: this.chain, program: p.name, instruction: handled.name, tx: shared.transaction.signature, address: instruction.address });
          continue;
        }
        const payload: SolanaInstructionEvent = { name: handled.name, program, args: args.value, accounts, accountList: instruction.accounts, data: instruction.data, address: instruction.address, isInner: instruction.isInner, ordinal, programInstructions, programLogs, ...shared };
        hits.push({ position: instruction.address, isLogLine: false, name, event: { kind: "solanaInstruction", payload } });
      }
    }
    return hits;
  }

  /** Events of `emit_cpi!` programs come from their self-CPI instructions, those of `emit!` programs from `Program data:` lines. */
  private emittedHits(p: ProgramSource, instructions: SolanaInstruction[], logs: SolanaLog[], shared: TransactionContext): ProgramHit[] {
    if (p.events.length === 0) return [];
    if (p.emit === "cpi") {
      return instructions.flatMap((i) => {
        if (!p.addresses.includes(i.program) || !isEventCpi(i)) return [];
        return this.programHit(p, shared, { payload: i.data.slice(EMIT_CPI_TAG.length), program: i.program, address: i.address.slice(0, -1), position: i.address, isLogLine: false });
      });
    }
    return logs.flatMap((l) => {
      if (l.kind !== "data" || !p.addresses.includes(l.program)) return [];
      const payload = Buffer.from(programData(l.message)).toString("hex");
      return this.programHit(p, shared, { payload, program: l.program, address: l.instructionAddress, position: l.instructionAddress ?? [], isLogLine: true });
    });
  }

  /** The event an emitted `payload` (hex) holds, decoded; none when the program has no handler for it. */
  private programHit(p: ProgramSource, shared: TransactionContext, emitted: { payload: string; program: string; address: number[] | null; position: number[]; isLogLine: boolean }): ProgramHit[] {
    const { payload, program, address, position, isLogLine } = emitted;
    const handled = p.events.find((e) => payload.startsWith(e.def.discriminator));
    if (!handled) return [];
    const name = `${p.name}:${handled.name}`;
    const data = tryDecode(handled.def.data, Buffer.from(payload.slice(handled.def.discriminator.length), "hex"));
    if (!data) {
      this.deps.obs.log.warn({ event: "decode_failed", chain: this.chain, program: p.name, eventName: handled.name, tx: shared.transaction.signature, address });
      return [];
    }
    return [{ position, isLogLine, name, event: { kind: "solanaProgram", payload: { name: handled.name, program, data: data.value, address, ...shared } } }];
  }

  // ------------------------------------------------------------ dispatch

  private async dispatch(events: DispatchEvent[], context: HandlerContext<any, string>, meta: { current: RowMeta }, writer: BatchWriter): Promise<number> {
    events.sort((a, b) => a.block - b.block || a.txIndex - b.txIndex || a.logIndex - b.logIndex);
    for (const [name, prefetchers] of this.deps.prefetchers) {
      const named = events.filter((e) => e.name === name).map((e) => e.payload);
      if (named.length === 0) continue;
      for (const p of prefetchers) await p({ events: named, context });
    }
    const { metrics, log } = this.deps.obs;
    let count = 0;
    for (const e of events) {
      const handlers = this.deps.handlers.get(e.name) ?? [];
      meta.current = { chain: this.chain, block: e.block, version: (BigInt(e.block) << 32n) + BigInt(e.txIndex & 0xffff) * 65536n + BigInt(e.logIndex & 0xffff) };
      this.currentBlock = e.block;
      for (const h of handlers) {
        const t0 = performance.now();
        try {
          await h({ event: e.payload, context });
        } catch (err) {
          metrics.recordError(this.chain, "handler");
          const detail = describeEvent(e);
          if (this.deps.onError === "skip") {
            log.error({ event: "handler_failed", chain: this.chain, handler: e.name, ...detail, error: { name: (err as Error).name, message: (err as Error).message } });
            continue;
          }
          throw createError({
            message: `handler ${e.name} failed at ${this.chain} block ${e.block}: ${(err as Error).message}`,
            why: `Unhandled exception in handler for ${e.name} (${JSON.stringify(detail)})`,
            fix: "Fix the handler, then re-run: the batch was discarded and will be re-processed from the checkpoint",
            cause: err as Error,
          });
        }
        metrics.recordEvent(this.chain, e.name, performance.now() - t0);
      }
      count++;
      if (writer.shouldFlush()) await writer.flush();
    }
    this.currentBlock = undefined;
    return count;
  }
}

function chainDefaults(plan: ChainPlan): { finality: number; pollInterval: number; maxBlockRange: number } {
  if (plan.kind === "bitcoin") return { finality: 3, pollInterval: 30_000, maxBlockRange: 50_000 };
  // A closed Stellar ledger is final (SCP has no forks); one closes every ~5 s.
  if (plan.kind === "stellar") return { finality: 0, pollInterval: 5_000, maxBlockRange: 100_000 };
  // ~32 slots (13 s) is Solana's finalized depth. Long ranges: Solana HyperSync fetches them in parallel windows.
  if (plan.kind === "solana") return { finality: 32, pollInterval: 2_000, maxBlockRange: 5_000_000 };
  if (plan.config.source.name.startsWith("rpc")) return { finality: 20, pollInterval: 2_000, maxBlockRange: 2_000 };
  return { finality: 20, pollInterval: 2_000, maxBlockRange: 100_000 };
}

function describeEvent(e: DispatchEvent): Record<string, unknown> {
  switch (e.kind) {
    case "contract":
      return { block: e.block, tx: e.payload.log.transactionHash, logIndex: e.payload.log.logIndex, address: e.payload.address };
    case "evmAccount":
      return { block: e.block, tx: e.payload.transaction.hash, address: e.payload.address };
    case "bitcoinAccount":
      return { block: e.block, txid: e.payload.tx.txid, address: e.payload.address };
    case "solanaAccount":
      return { block: e.block, tx: e.payload.transaction.signature, address: e.payload.address };
    case "stellarAccount":
      return { block: e.block, tx: e.payload.transaction.hash, address: e.payload.address };
    case "solanaInstruction":
    case "solanaProgram":
      return { block: e.block, tx: e.payload.transaction.signature, program: e.payload.program, address: e.payload.address };
  }
}

/** An `emit_cpi!` event: an inner instruction carrying Anchor's event tag. */
function isEventCpi(instruction: SolanaInstruction): boolean {
  return instruction.isInner && instruction.data.startsWith(EMIT_CPI_TAG);
}

function tryDecode<T>(codec: Codec<T>, bytes: Uint8Array): { value: T } | null {
  try {
    return { value: decode(codec, bytes) };
  } catch {
    return null;
  }
}

/** The instruction's accounts under the definition's names, or null when it got fewer accounts than named. */
function bindAccounts(names: readonly string[], accounts: string[]): Record<string, string> | null {
  const bound: Record<string, string> = {};
  for (const [index, name] of names.entries()) {
    const account = accounts[index];
    if (account === undefined) return null;
    bound[name] = account;
  }
  return bound;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k) ?? [];
    group.push(item);
    groups.set(k, group);
  }
  return groups;
}

function hashIndex(txid: string): number {
  return parseInt(txid.slice(0, 6), 16) & 0xffff;
}

export type { EvmTransaction };
