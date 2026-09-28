import { metrics as otelMetrics, trace, type Meter, type Tracer, type Attributes } from "@opentelemetry/api";

/**
 * OpenTelemetry instruments + an in-process snapshot. The OTEL API is a no-op
 * until an SDK is registered (see `yail/otel`), the snapshot always works and
 * feeds `GET /status`.
 */
export interface ChainStats {
  cursor: number;
  head: number;
  finalized: number;
  lagBlocks: number;
  blocksIndexed: number;
  eventsProcessed: number;
  batches: number;
  errors: number;
  lastBatchMs: number;
  lastBatchAt?: string;
  caughtUp: boolean;
}

type CounterName = keyof Metrics["counters"];
const CACHE_COUNTERS: Record<"source" | "http" | "rpc", [CounterName, CounterName]> = {
  source: ["cacheHits", "cacheMisses"],
  http: ["httpCacheHits", "httpCacheMisses"],
  rpc: ["rpcCacheHits", "rpcCacheMisses"],
};

export class Metrics {
  readonly meter: Meter;
  readonly tracer: Tracer;
  readonly chains = new Map<string, ChainStats>();
  readonly counters = { sourceRequests: 0, cacheHits: 0, cacheMisses: 0, httpCacheHits: 0, httpCacheMisses: 0, rpcCacheHits: 0, rpcCacheMisses: 0, rowsFlushed: 0, jobsDone: 0, jobsFailed: 0 };

  private blocksIndexed;
  private eventsProcessed;
  private batchDuration;
  private handlerDuration;
  private flushRows;
  private flushDuration;
  private errors;
  private cacheEvents;
  private jobEvents;
  private sourceDuration;

  constructor(serviceName = "yail") {
    this.meter = otelMetrics.getMeter(serviceName);
    this.tracer = trace.getTracer(serviceName);
    const m = this.meter;
    this.blocksIndexed = m.createCounter("yail.blocks.indexed", { description: "Blocks indexed", unit: "{block}" });
    this.eventsProcessed = m.createCounter("yail.events.processed", { description: "Events dispatched to handlers", unit: "{event}" });
    this.batchDuration = m.createHistogram("yail.batch.duration", { description: "Source batch end-to-end processing time", unit: "ms" });
    this.handlerDuration = m.createHistogram("yail.handler.duration", { description: "Handler execution time", unit: "ms" });
    this.flushRows = m.createCounter("yail.flush.rows", { description: "Rows written to ClickHouse", unit: "{row}" });
    this.flushDuration = m.createHistogram("yail.flush.duration", { description: "ClickHouse insert time per table", unit: "ms" });
    this.errors = m.createCounter("yail.errors", { description: "Errors by stage" });
    this.cacheEvents = m.createCounter("yail.cache.events", { description: "Cache hits/misses by cache" });
    this.jobEvents = m.createCounter("yail.jobs", { description: "Backfill / reindex jobs by outcome" });
    this.sourceDuration = m.createHistogram("yail.source.duration", { description: "Time waiting on the data source per batch", unit: "ms" });

    m.createObservableGauge("yail.chain.head", { description: "Source head block" }).addCallback((r) => {
      for (const [chain, s] of this.chains) r.observe(s.head, { chain });
    });
    m.createObservableGauge("yail.chain.cursor", { description: "Next block to index" }).addCallback((r) => {
      for (const [chain, s] of this.chains) r.observe(s.cursor, { chain });
    });
    m.createObservableGauge("yail.chain.lag_blocks", { description: "finalized head - cursor. Alert when this grows." }).addCallback((r) => {
      for (const [chain, s] of this.chains) r.observe(s.lagBlocks, { chain });
    });
    m.createObservableGauge("yail.chain.caught_up", { description: "1 when the chain is at the finalized head" }).addCallback((r) => {
      for (const [chain, s] of this.chains) r.observe(Number(s.caughtUp), { chain });
    });
  }

  chain(name: string): ChainStats {
    let s = this.chains.get(name);
    if (!s) {
      s = { cursor: 0, head: 0, finalized: 0, lagBlocks: 0, blocksIndexed: 0, eventsProcessed: 0, batches: 0, errors: 0, lastBatchMs: 0, caughtUp: false };
      this.chains.set(name, s);
    }
    return s;
  }

  setProgress(chain: string, cursor: number, head: number, finalized: number): void {
    const s = this.chain(chain);
    s.cursor = cursor;
    s.head = head;
    s.finalized = finalized;
    s.lagBlocks = Math.max(0, finalized + 1 - cursor);
    s.caughtUp = cursor > finalized;
  }

  recordBatch(chain: string, blocks: number, events: number, ms: number, sourceMs: number): void {
    const s = this.chain(chain);
    s.blocksIndexed += blocks;
    s.eventsProcessed += events;
    s.batches++;
    s.lastBatchMs = ms;
    s.lastBatchAt = new Date().toISOString();
    this.blocksIndexed.add(blocks, { chain });
    this.batchDuration.record(ms, { chain });
    this.sourceDuration.record(sourceMs, { chain });
  }

  recordEvent(chain: string, name: string, ms: number): void {
    this.eventsProcessed.add(1, { chain, event: name });
    this.handlerDuration.record(ms, { chain, event: name });
  }

  recordFlush(table: string, rows: number, ms: number): void {
    this.counters.rowsFlushed += rows;
    this.flushRows.add(rows, { table });
    this.flushDuration.record(ms, { table });
  }

  recordError(chain: string | undefined, stage: string): void {
    if (chain) this.chain(chain).errors++;
    this.errors.add(1, { chain: chain ?? "", stage });
  }

  recordCache(cache: "source" | "http" | "rpc", hit: boolean): void {
    const [hitCounter, missCounter] = CACHE_COUNTERS[cache];
    let result = "miss";
    let counter = missCounter;
    if (hit) {
      result = "hit";
      counter = hitCounter;
    }
    this.counters[counter]++;
    this.cacheEvents.add(1, { cache, result });
  }

  recordJob(kind: string, outcome: "done" | "failed"): void {
    if (outcome === "done") this.counters.jobsDone++;
    else this.counters.jobsFailed++;
    this.jobEvents.add(1, { kind, outcome });
  }

  snapshot(): { chains: Record<string, ChainStats>; counters: Metrics["counters"] } {
    return { chains: Object.fromEntries(this.chains), counters: { ...this.counters } };
  }

  span<T>(name: string, attributes: Attributes, fn: () => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(name, { attributes }, async (span) => {
      try {
        return await fn();
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: 2, message: (err as Error).message });
        throw err;
      } finally {
        span.end();
      }
    });
  }
}
