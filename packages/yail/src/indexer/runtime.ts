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
import type { BitcoinBatch, BitcoinSource, EvmBatch, EvmBlock, EvmLog, EvmSource, EvmTrace, EvmTransaction } from "../sources/types.js";
import { logOrder } from "../sources/types.js";
import { isAddressSet, isFactory } from "../config/address.js";
import type { Config } from "../config/types.js";
import { createContext, type HandlerContext } from "./context.js";
import { EffectCache } from "../effects/effect.js";
import { bitcoinAccountEvent, decodeLog, directionOf, involvedAddresses, logMatchesFilter, type ContractEvent, type EvmAccountEvent, type BitcoinAccountEvent, type SetupEvent } from "./events.js";
import { buildBitcoinQuery, buildEvmQuery, nextBoundary, resolveAddresses, type ChainPlan, type ContractSource, type QueryBuildOptions } from "./plan.js";
import type { BitcoinQuery, EvmQuery } from "../sources/types.js";
import { toArray } from "../util.js";

export type Handler = (args: { event: any; context: HandlerContext<any, any> }) => Promise<void> | void;

export interface RuntimeDeps {
  config: Config<any, any, any>;
  db: Db;
  registry: AddressRegistry;
  obs: Observability;
  http: HttpClient;
  handlers: Map<string, Handler[]>;
  contracts: Record<string, { abi: any; address?: string }>;
  /** Called by the live loop when newly adopted addresses need history. */
  enqueueBackfill: (chain: string, job: { set: string; address: string; fromBlock: number; toBlock: number }) => Promise<void>;
  /** Called on a detected reorg to re-index a window. */
  enqueueReindex: (chain: string, fromBlock: number, toBlock: number) => Promise<void>;
  onError?: "stop" | "skip";
}

interface DispatchEvent {
  block: number;
  txIndex: number;
  logIndex: number;
  name: string;
  payload: ContractEvent | EvmAccountEvent | BitcoinAccountEvent;
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
        const spec = seedSpec(item);
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

  /** Adopt newly registered addresses at the current cursor and schedule their history. */
  private async adoptPending(): Promise<void> {
    const pending = this.deps.registry.unadopted(this.chain);
    if (pending.length === 0) return;
    const at = this.cursor;
    const needBackfill = pending.filter((r) => Number(r.fromBlock) < at);
    const liveNow = pending.filter((r) => Number(r.fromBlock) >= at);
    await this.deps.registry.updateMany(needBackfill, { adopted: true, adoptedAtBlock: BigInt(at), status: "pending" });
    await this.deps.registry.updateMany(liveNow, { adopted: true, adoptedAtBlock: BigInt(at), status: "live" });
    for (const r of needBackfill) {
      await this.deps.enqueueBackfill(this.chain, { set: r.set, address: r.address, fromBlock: Number(r.fromBlock), toBlock: at });
    }
    if (pending.length > 0) {
      this.deps.obs.log.info({ event: "addresses_adopted", chain: this.chain, atBlock: at, live: liveNow.length, backfill: needBackfill.length });
    }
  }

  /**
   * Fetch + process a block range. In live mode this advances the cursor and
   * writes checkpoints after every batch; in backfill mode it only writes data.
   */
  async processRange(from: number, to: number, options: ProcessRangeOptions): Promise<{ batches: number; events: number }> {
    const { metrics, log } = this.deps.obs;
    const stats = { batches: 0, events: 0 };
    if (from >= to) return stats;
    const source = this.plan.config.source;
    const addressChunk = this.deps.config.indexing?.addressChunk ?? 500;
    const flushMaxRows = this.deps.config.indexing?.flushMaxRows ?? 50_000;
    const live = !options.backfill;

    let query: EvmQuery | BitcoinQuery;
    let empty: boolean;
    if (this.plan.kind === "evm") {
      const q = buildEvmQuery(this.plan, from, to, this.deps.registry, { override: options.override, addressChunk });
      query = q;
      empty = q.logs.length === 0 && q.transactions.length === 0;
    } else {
      const q = buildBitcoinQuery(this.plan, from, to, this.deps.registry, { override: options.override });
      query = q;
      empty = q.addresses.length === 0;
    }
    if (empty) {
      if (live) await this.advance(to);
      return stats;
    }

    let batchFrom = from;
    let sourceStart = performance.now();
    const iterator = (source as EvmSource | BitcoinSource).fetch(query as any, { signal: options.signal })[Symbol.asyncIterator]();
    for (;;) {
      const next = await iterator.next();
      const sourceMs = performance.now() - sourceStart;
      if (next.done) break;
      const batch = next.value as EvmBatch | BitcoinBatch;
      const started = performance.now();
      const wide = this.deps.obs.wide({ chain: this.chain, mode: options.label ?? modeLabel(live), fromBlock: batch.fromBlock, toBlock: batch.nextBlock - 1 });
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
        let stage = "backfill";
        if (live) stage = "batch";
        metrics.recordError(this.chain, stage);
        throw err;
      }
      const ms = performance.now() - started;
      stats.batches++;
      stats.events += eventCount;
      metrics.recordBatch(this.chain, batch.nextBlock - batch.fromBlock, eventCount, ms, sourceMs);
      wide.set({ events: eventCount, logs: (batch as EvmBatch).logs?.length ?? 0, transactions: batch.transactions.length, sourceMs: Math.round(sourceMs), processMs: Math.round(ms), rows: metrics.counters.rowsFlushed });
      if (this.deps.obs.config.batchEvents) wide.emit();
      batchFrom = batch.nextBlock;
      sourceStart = performance.now();
    }
    if (live && batchFrom < to) await this.advance(to);
    if (!live && batchFrom < to) {
      log.warn({ event: "range_incomplete", chain: this.chain, from, to, reached: batchFrom });
    }
    return stats;
  }

  private async advance(nextBlock: number): Promise<void> {
    this.cursor = nextBlock;
    await this.deps.db.insert(checkpoints).values({ chain: this.chain, cursor: BigInt(nextBlock), head: BigInt(this.head), updatedAt: new Date() });
    this.deps.obs.metrics.setProgress(this.chain, this.cursor, this.head, this.finalized);
  }

  private effects?: EffectCache;

  private makeContext(writer: BatchWriter, meta: { current: RowMeta }, log: WideLogger, backfill: boolean): HandlerContext<any, string> {
    const chain = { name: this.chain, id: this.plan.config.id, kind: this.plan.kind };
    this.effects ??= new EffectCache(this.deps.db, { chain, client: this.client, http: this.deps.http }, (hit) => this.deps.obs.metrics.recordCache("effect", hit));
    return createContext({
      db: this.deps.db,
      writer,
      registry: this.deps.registry,
      http: this.deps.http,
      client: this.client,
      effects: this.effects,
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
        events.push({ block: log.blockNumber, txIndex: log.transactionIndex, logIndex: log.logIndex + 1, name, payload });
      }
    }

    const logsOf = byTransaction([...batch.logs].sort(logOrder));
    const tracesOf = byTransaction(batch.traces ?? []);
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
          events.push({ block: tx.blockNumber, txIndex: tx.transactionIndex, logIndex: 0, name, payload });
        }
      }
    }

    events.sort((a, b) => a.block - b.block || a.txIndex - b.txIndex || a.logIndex - b.logIndex);
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
          if (payload) events.push({ block: tx.blockHeight, txIndex: hashIndex(tx.txid), logIndex: idx++, name, payload });
        }
      }
    }
    events.sort((a, b) => a.block - b.block || a.txIndex - b.txIndex || a.logIndex - b.logIndex);
    return this.dispatch(events, context, meta, writer);
  }

  // ------------------------------------------------------------ dispatch

  private async dispatch(events: DispatchEvent[], context: HandlerContext<any, string>, meta: { current: RowMeta }, writer: BatchWriter): Promise<number> {
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
  if (plan.config.source.name.startsWith("rpc")) return { finality: 20, pollInterval: 2_000, maxBlockRange: 2_000 };
  return { finality: 20, pollInterval: 2_000, maxBlockRange: 100_000 };
}

type Seed = { address: string; chain?: string; fromBlock?: number };
function seedSpec(item: string | Seed): Seed {
  if (typeof item === "string") return { address: item };
  return item;
}

function modeLabel(live: boolean): string {
  if (live) return "live";
  return "backfill";
}

function describeEvent(e: DispatchEvent): Record<string, unknown> {
  const p = e.payload as any;
  if (p.log) return { block: e.block, tx: p.log.transactionHash, logIndex: p.log.logIndex, address: p.address };
  if (p.transaction) return { block: e.block, tx: p.transaction.hash, address: p.address };
  if (p.tx) return { block: e.block, txid: p.tx.txid, address: p.address };
  return { block: e.block };
}

function byTransaction<T extends { transactionHash: string }>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.transactionHash) ?? [];
    group.push(item);
    groups.set(item.transactionHash, group);
  }
  return groups;
}

function hashIndex(txid: string): number {
  return parseInt(txid.slice(0, 6), 16) & 0xffff;
}

export type { EvmTransaction };
