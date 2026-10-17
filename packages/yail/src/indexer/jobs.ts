import { randomUUID } from "node:crypto";
import type { AddressRegistry, AddressRow } from "../addresses/registry.js";
import type { Db } from "../db/client.js";
import { jobs as jobsTable } from "../db/internal.js";
import { sql } from "../db/sql.js";
import type { InferRow, Table } from "../schema/table.js";
import { INDEX_META_COLUMNS } from "../schema/table.js";
import type { Observability } from "../observability/logger.js";
import type { ChainRunner } from "./runtime.js";
import { chunkList } from "../util.js";

const MAX_JOB_ATTEMPTS = 8;

export type JobRow = InferRow<typeof jobsTable>;
export type JobKind = JobRow["kind"];

export interface BackfillAddressPayload {
  set: string;
  /** Read in one source query (split in halves if the source refuses it as too large). */
  addresses: string[];
  fromBlock: number;
  toBlock: number;
}
/** Jobs enqueued before backfills were batched carry one `address`. */
type StoredBackfillPayload = BackfillAddressPayload | (Omit<BackfillAddressPayload, "addresses"> & { addresses?: undefined; address: string });
export interface ReindexRangePayload {
  fromBlock: number;
  toBlock: number;
}
export interface ReindexScopePayload {
  scope: string;
  value: string;
}

/**
 * Durable per-chain job queue. Jobs are persisted in `_yail_jobs` so a
 * restart resumes them; other processes (CLI, API) can enqueue by inserting
 * rows, which the worker picks up when it polls.
 */
export class JobRunner {
  private queue: JobRow[] = [];
  private delayed = new Map<string, NodeJS.Timeout>();
  private active = 0;
  private stopped = false;
  private wake: (() => void) | undefined;
  private loopPromise: Promise<void> | undefined;
  private lastPoll = 0;

  constructor(
    private readonly deps: { db: Db; registry: AddressRegistry; obs: Observability; tables: Table<any>[]; concurrency: number; pollIntervalMs?: number },
    readonly runner: ChainRunner,
  ) {}

  get chain(): string {
    return this.runner.chain;
  }

  get pending(): number {
    return this.queue.length + this.active + this.delayed.size;
  }

  async enqueue(kind: JobKind, payload: BackfillAddressPayload | ReindexRangePayload | ReindexScopePayload): Promise<JobRow> {
    const now = new Date();
    const row: JobRow = { id: randomUUID(), chain: this.chain, kind, payload: payload as any, status: "pending", attempts: 0, error: "", createdAt: now, updatedAt: now };
    await this.deps.db.insert(jobsTable).values(row);
    this.queue.push(row);
    this.wake?.();
    return row;
  }

  /**
   * Load unfinished jobs from the database (own chain only). Finds them by id and status alone, then reads whole rows
   * only for the jobs this runner does not hold: a batched backfill's payload carries its addresses and is written
   * again at every checkpoint, so reading every payload on every poll is most of the database's work.
   */
  async poll(): Promise<number> {
    const finishedBefore = [...this.finished];
    const unfinished = await this.deps.db.query<{ id: string }>(sql`SELECT id FROM ${jobsTable} FINAL WHERE chain = ${this.chain} AND status IN ('pending', 'running') ORDER BY created_at`);
    for (const id of finishedBefore) this.finished.delete(id);
    const known = new Set([...this.queue.map((j) => j.id), ...this.finished, ...this.runningIds, ...this.delayed.keys()]);
    const fresh = unfinished.map((r) => r.id).filter((id) => !known.has(id));
    let added = 0;
    for (const ids of chunkList(fresh, 1_000)) {
      const rows = await this.deps.db.rows(jobsTable, sql`WHERE has(${ids}, id) AND status IN ('pending', 'running') ORDER BY created_at`);
      for (const r of rows) {
        if (this.runningIds.has(r.id) || this.delayed.has(r.id) || this.finished.has(r.id)) continue;
        this.queue.push(r);
        added++;
      }
    }
    if (added > 0) this.wake?.();
    return added;
  }

  private runningIds = new Set<string>();
  /** Jobs that finished while a poll was reading: it may have read them as unfinished. */
  private finished = new Set<string>();

  start(): void {
    this.stopped = false;
    this.loopPromise ??= this.loop();
  }

  /** Pending retries are dropped: their jobs stay pending in `_yail_jobs` and run as soon as a runner polls them. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.delayed.values()) clearTimeout(timer);
    this.delayed.clear();
    this.wake?.();
    await this.loopPromise;
    this.loopPromise = undefined;
  }

  /** Resolve once no job is queued, running or waiting to be retried. */
  async drain(): Promise<void> {
    for (;;) {
      await this.poll();
      if (this.pending === 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (Date.now() - this.lastPoll > (this.deps.pollIntervalMs ?? 10_000)) {
        this.lastPoll = Date.now();
        await this.poll().catch((err) => this.deps.obs.log.warn({ event: "jobs_poll_failed", chain: this.chain, error: String(err) }));
      }
      while (this.active < this.deps.concurrency && this.queue.length > 0) {
        const job = this.queue.shift()!;
        this.active++;
        this.runningIds.add(job.id);
        void this.execute(job)
          .catch((err) => this.deps.obs.log.warn({ event: "job_crashed", chain: this.chain, jobId: job.id, error: String(err) }))
          .finally(() => {
            this.active--;
            this.runningIds.delete(job.id);
            this.finished.add(job.id);
            this.wake?.();
          });
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        setTimeout(resolve, 1000);
      });
      this.wake = undefined;
    }
  }

  private async execute(job: JobRow): Promise<void> {
    const { obs } = this.deps;
    const { addresses, ...payload } = job.payload;
    const wide = obs.wide({ chain: this.chain, job: job.kind, jobId: job.id, ...payload, ...(Array.isArray(addresses) && { addresses: addresses.length }) });
    job.attempts += 1;
    job.status = "running";
    await this.save(job);
    try {
      if (job.kind === "backfill_address") await this.backfillAddresses(backfillPayload(job), this.checkpoint(job));
      else if (job.kind === "reindex_range") await this.reindexRange(job.payload as unknown as ReindexRangePayload, this.checkpoint(job));
      else if (job.kind === "reindex_scope") await this.reindexScope(job.payload as unknown as ReindexScopePayload);
      job.status = "done";
      await this.save(job);
      obs.metrics.recordJob(job.kind, "done");
      wide.set({ outcome: "done" });
    } catch (err) {
      const retry = job.attempts < MAX_JOB_ATTEMPTS;
      job.status = "failed";
      if (retry) job.status = "pending";
      job.error = (err as Error).message;
      await this.save(job).catch((saveErr) => obs.log.warn({ event: "job_save_failed", chain: this.chain, jobId: job.id, error: String(saveErr) }));
      if (!retry) obs.metrics.recordJob(job.kind, "failed");
      obs.metrics.recordError(this.chain, "job");
      wide.error(err as Error);
      wide.set({ outcome: job.status, attempts: job.attempts });
      if (retry) {
        const retryInMs = 30_000 * 2 ** (job.attempts - 1);
        wide.set({ retryInMs });
        this.retryLater(job, retryInMs);
      } else if (job.kind === "backfill_address") {
        await this.deps.registry.updateMany(this.registered(backfillPayload(job)), { status: "failed", error: job.error });
      }
    } finally {
      wide.emit();
    }
  }

  private async save(job: JobRow): Promise<void> {
    job.updatedAt = new Date();
    await this.deps.db.insert(jobsTable).values(job);
  }

  /**
   * Moves the job's `fromBlock` past every batch written, so a retry resumes there, and saves it at most once a
   * minute, so a restart does too.
   */
  private checkpoint(job: JobRow): (nextBlock: number) => Promise<void> {
    let savedAt = Date.now();
    return async (nextBlock) => {
      job.payload = { ...job.payload, fromBlock: nextBlock };
      if (Date.now() - savedAt < 60_000) return;
      savedAt = Date.now();
      await this.save(job);
    };
  }

  private retryLater(job: JobRow, delayMs: number): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.delayed.delete(job.id);
      this.queue.push(job);
      this.wake?.();
    }, delayMs);
    timer.unref();
    this.delayed.set(job.id, timer);
  }

  private async backfillAddresses(p: BackfillAddressPayload, onProgress?: (nextBlock: number) => Promise<void>): Promise<void> {
    await this.deps.registry.updateMany(this.registered(p), { status: "backfilling" });
    let reached = p.fromBlock;
    const progress = async (nextBlock: number) => {
      reached = nextBlock;
      await onProgress?.(nextBlock);
    };
    try {
      await this.runner.processRange(p.fromBlock, p.toBlock, { backfill: true, override: { set: p.set, addresses: p.addresses }, label: "backfill", source: this.runner.plan.config.backfillSource, onProgress: progress });
    } catch (err) {
      if (p.addresses.length === 1 || !/payload (is )?too large/i.test((err as Error).message)) throw err;
      const half = Math.ceil(p.addresses.length / 2);
      this.deps.obs.log.warn({ event: "backfill_split", chain: this.chain, addresses: p.addresses.length, fromBlock: reached });
      await this.enqueue("backfill_address", { ...p, addresses: p.addresses.slice(0, half), fromBlock: reached });
      await this.enqueue("backfill_address", { ...p, addresses: p.addresses.slice(half), fromBlock: reached });
      return;
    }
    await this.deps.registry.updateMany(this.registered(p), { status: "live", error: "" });
  }

  private registered(p: BackfillAddressPayload): AddressRow[] {
    return p.addresses.flatMap((address) => this.deps.registry.get(p.set, this.chain, address) ?? []);
  }

  private async reindexRange(p: ReindexRangePayload, onProgress: (nextBlock: number) => Promise<void>): Promise<void> {
    const to = Math.min(p.toBlock, this.runner.cursor);
    for (const t of this.deps.tables) {
      if (t.options.indexMeta === false) continue;
      await this.deps.db.command(
        sql`DELETE FROM ${t} WHERE ${sql.identifier(INDEX_META_COLUMNS.chain)} = ${this.chain} AND ${sql.identifier(INDEX_META_COLUMNS.block)} >= ${p.fromBlock} AND ${sql.identifier(INDEX_META_COLUMNS.block)} < ${to}`,
      );
    }
    await this.runner.processRange(p.fromBlock, to, { backfill: true, label: "reindex", onProgress });
  }

  private async reindexScope(p: ReindexScopePayload): Promise<void> {
    let value = p.value;
    if (value.startsWith("0x")) value = value.toLowerCase();
    for (const t of this.deps.tables) {
      const col = t.options.scopes?.[p.scope];
      if (!col) continue;
      let cond = sql``;
      if (t.options.indexMeta !== false) cond = sql` AND ${sql.identifier(INDEX_META_COLUMNS.chain)} = ${this.chain}`;
      await this.deps.db.command(sql`DELETE FROM ${t} WHERE ${sql.identifier(t.columnName(col))} = ${value}${cond}`);
    }
    // Re-run history for every set the value belongs to on this chain.
    const memberships = this.deps.registry.setsContaining(this.chain, value).filter((r) => !r.set.startsWith("__factory:"));
    for (const m of memberships) {
      await this.backfillAddresses({ set: m.set, addresses: [m.address], fromBlock: Number(m.fromBlock), toBlock: this.runner.cursor });
    }
  }
}

function backfillPayload(job: JobRow): BackfillAddressPayload {
  const p = job.payload as unknown as StoredBackfillPayload;
  if (p.addresses !== undefined) return p;
  return { set: p.set, addresses: [p.address], fromBlock: p.fromBlock, toBlock: p.toBlock };
}
