import { randomUUID } from "node:crypto";
import type { AddressRegistry } from "../addresses/registry.js";
import type { Db } from "../db/client.js";
import { jobs as jobsTable } from "../db/internal.js";
import { sql } from "../db/sql.js";
import type { InferRow, Table } from "../schema/table.js";
import { INDEX_META_COLUMNS } from "../schema/table.js";
import type { Observability } from "../observability/logger.js";
import type { ChainRunner } from "./runtime.js";

export type JobRow = InferRow<typeof jobsTable>;
export type JobKind = JobRow["kind"];

export interface BackfillAddressPayload {
  set: string;
  address: string;
  fromBlock: number;
  toBlock: number;
}
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
    return this.queue.length + this.active;
  }

  async enqueue(kind: JobKind, payload: BackfillAddressPayload | ReindexRangePayload | ReindexScopePayload): Promise<JobRow> {
    const now = new Date();
    const row: JobRow = { id: randomUUID(), chain: this.chain, kind, payload: payload as any, status: "pending", attempts: 0, error: "", createdAt: now, updatedAt: now };
    await this.deps.db.insert(jobsTable).values(row);
    this.queue.push(row);
    this.wake?.();
    return row;
  }

  /** Load unfinished jobs from the database (own chain only). */
  async poll(): Promise<number> {
    const rows = await this.deps.db.rows(jobsTable, sql`WHERE chain = ${this.chain} AND status IN ('pending', 'running') ORDER BY created_at`);
    const known = new Set(this.queue.map((j) => j.id));
    let added = 0;
    for (const r of rows) {
      if (known.has(r.id) || this.runningIds.has(r.id)) continue;
      this.queue.push(r);
      added++;
    }
    if (added > 0) this.wake?.();
    return added;
  }

  private runningIds = new Set<string>();

  start(): void {
    this.stopped = false;
    this.loopPromise ??= this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.loopPromise;
  }

  /** Resolve once the queue is empty and no job is running. */
  async drain(): Promise<void> {
    for (;;) {
      await this.poll();
      if (this.queue.length === 0 && this.active === 0) return;
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
        void this.execute(job).finally(() => {
          this.active--;
          this.runningIds.delete(job.id);
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
    const wide = obs.wide({ chain: this.chain, job: job.kind, jobId: job.id, ...job.payload });
    const update = (patch: Partial<JobRow>) => this.deps.db.insert(jobsTable).values({ ...job, ...patch, updatedAt: new Date() });
    job.attempts += 1;
    await update({ status: "running", attempts: job.attempts });
    try {
      if (job.kind === "backfill_address") await this.backfillAddress(job.payload as unknown as BackfillAddressPayload);
      else if (job.kind === "reindex_range") await this.reindexRange(job.payload as unknown as ReindexRangePayload);
      else if (job.kind === "reindex_scope") await this.reindexScope(job.payload as unknown as ReindexScopePayload);
      job.status = "done";
      await update({ status: "done" });
      obs.metrics.recordJob(job.kind, "done");
      wide.set({ outcome: "done" });
    } catch (err) {
      const retry = job.attempts < 3;
      job.status = retry ? "pending" : "failed";
      job.error = (err as Error).message;
      await update({ status: job.status, error: job.error });
      obs.metrics.recordJob(job.kind, retry ? "done" : "failed");
      obs.metrics.recordError(this.chain, "job");
      wide.error(err as Error);
      wide.set({ outcome: job.status, attempts: job.attempts });
      if (retry) this.queue.push(job);
      else if (job.kind === "backfill_address") {
        const p = job.payload as unknown as BackfillAddressPayload;
        await this.deps.registry.update(p.set, this.chain, p.address, { status: "failed", error: job.error });
      }
    } finally {
      wide.emit();
    }
  }

  private async backfillAddress(p: BackfillAddressPayload): Promise<void> {
    await this.deps.registry.update(p.set, this.chain, p.address, { status: "backfilling" });
    await this.runner.processRange(p.fromBlock, p.toBlock, { backfill: true, override: { set: p.set, addresses: [p.address] }, label: "backfill" });
    await this.deps.registry.update(p.set, this.chain, p.address, { status: "live", error: "" });
  }

  private async reindexRange(p: ReindexRangePayload): Promise<void> {
    const to = Math.min(p.toBlock, this.runner.cursor);
    for (const t of this.deps.tables) {
      if (t.options.indexMeta === false) continue;
      await this.deps.db.command(
        sql`DELETE FROM ${t} WHERE ${sql.identifier(INDEX_META_COLUMNS.chain)} = ${this.chain} AND ${sql.identifier(INDEX_META_COLUMNS.block)} >= ${p.fromBlock} AND ${sql.identifier(INDEX_META_COLUMNS.block)} < ${to}`,
      );
    }
    await this.runner.processRange(p.fromBlock, to, { backfill: true, label: "reindex" });
  }

  private async reindexScope(p: ReindexScopePayload): Promise<void> {
    const value = p.value.startsWith("0x") ? p.value.toLowerCase() : p.value;
    for (const t of this.deps.tables) {
      const col = t.options.scopes?.[p.scope];
      if (!col) continue;
      const cond = t.options.indexMeta === false ? sql`` : sql` AND ${sql.identifier(INDEX_META_COLUMNS.chain)} = ${this.chain}`;
      await this.deps.db.command(sql`DELETE FROM ${t} WHERE ${sql.identifier(t.columnName(col))} = ${value}${cond}`);
    }
    // Re-run history for every set the value belongs to on this chain.
    const memberships = this.deps.registry.setsContaining(this.chain, value).filter((r) => !r.set.startsWith("__factory:"));
    for (const m of memberships) {
      await this.backfillAddress({ set: m.set, address: m.address, fromBlock: Number(m.fromBlock), toBlock: this.runner.cursor });
    }
  }
}
