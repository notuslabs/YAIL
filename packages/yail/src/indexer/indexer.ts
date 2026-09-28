import { AddressRegistry, type AddressRow } from "../addresses/registry.js";
import type { Config } from "../config/types.js";
import { createDb, type Db } from "../db/client.js";
import { collectSchema, migrate, type MigrateOptions, type SchemaModule } from "../db/migrate.js";
import { createHttpClient, type HttpClient } from "../http/client.js";
import { initObservability, type Observability } from "../observability/logger.js";
import { cached } from "../sources/cached.js";
import type { MaterializedView } from "../schema/view.js";
import type { Table } from "../schema/table.js";
import { isAddressSet, isFactory } from "../config/address.js";
import type { HandlerContext } from "./context.js";
import type { ChainNames, EventNames, EventOf } from "./events.js";
import { JobRunner, type JobRow } from "./jobs.js";
import { buildPlans, type ChainPlan } from "./plan.js";
import { ChainRunner, type Handler } from "./runtime.js";
import { toArray } from "../util.js";

export interface IndexerOptions<C extends Config<any, any, any>> {
  config: C;
  /** The schema module (`import * as schema from "./schema"`) or an array of tables/views. */
  schema: SchemaModule | ReadonlyArray<Table<any> | MaterializedView>;
  /** What to do when a handler throws. `stop` (default) halts the chain so data stays consistent. */
  onError?: "stop" | "skip";
  /** Override `fetch` used by `context.http` (tests). */
  fetch?: typeof fetch;
}

export interface StatusSnapshot {
  chains: Record<string, { cursor: number; head: number; finalized: number; lagBlocks: number; caughtUp: boolean; running: boolean; error?: string; pendingJobs: number; blocksIndexed: number; eventsProcessed: number; batches: number; errors: number; lastBatchMs: number; lastBatchAt?: string }>;
  addresses: Array<{ set: string; chain: string; status: string; count: number }>;
  counters: Record<string, number>;
}

export interface ReindexRequest {
  chain: string;
  /** Re-index a block range [fromBlock, toBlock). */
  fromBlock?: number;
  toBlock?: number;
  /** Or re-index one entity: delete rows where the scope column equals `value` and re-run its address history. */
  scope?: string;
  value?: string;
}

export interface Indexer<C extends Config<any, any, any>> {
  readonly config: C;
  readonly schema: SchemaModule | ReadonlyArray<Table<any> | MaterializedView>;
  /** Register a handler. Names are `Contract:Event`, `Account:transaction`, or `setup`. */
  on<name extends EventNames<C>>(name: name, handler: (args: { event: EventOf<C, name>; context: HandlerContext<C, ChainNames<C>> }) => Promise<void> | void): Indexer<C>;
  /** Connect, migrate, and prepare runners without indexing. Idempotent. */
  init(): Promise<void>;
  /** Run migrations only. */
  migrate(options?: MigrateOptions): Promise<void>;
  /** Index continuously (live). Resolves when stopped or when a chain fails. */
  start(options?: { server?: boolean }): Promise<void>;
  /** Index until every chain is caught up to its finalized head and all jobs are done, then stop. For tests and one-shot runs. */
  run(): Promise<void>;
  stop(): Promise<void>;
  /** The ClickHouse client (available after `init`). */
  readonly db: Db;
  readonly observability: Observability;
  readonly http: HttpClient;
  addresses: {
    register(input: { set: string; address: string; chain?: string; fromBlock?: number; meta?: Record<string, unknown> } | Array<{ set: string; address: string; chain?: string; fromBlock?: number; meta?: Record<string, unknown> }>): Promise<AddressRow[]>;
    list(filter?: { set?: string; chain?: string; status?: AddressRow["status"] }): AddressRow[];
    has(set: string, chain: string, address: string): boolean;
  };
  reindex(request: ReindexRequest): Promise<JobRow[]>;
  status(): Promise<StatusSnapshot>;
  /** Internal: access to plans/runners (used by the server and tests). */
  readonly internals: { plans: Map<string, ChainPlan>; runners: Map<string, ChainRunner>; jobs: Map<string, JobRunner>; registry: AddressRegistry };
}

export function createIndexer<C extends Config<any, any, any>>(options: IndexerOptions<C>): Indexer<C> {
  const { config } = options;
  const handlers = new Map<string, Handler[]>();
  const plans = new Map<string, ChainPlan>();
  const runners = new Map<string, ChainRunner>();
  const jobRunners = new Map<string, JobRunner>();
  let db: Db | undefined;
  let obs: Observability | undefined;
  let http: HttpClient | undefined;
  let registry: AddressRegistry | undefined;
  let initPromise: Promise<void> | undefined;
  let serverHandle: { close(): Promise<void> } | undefined;

  const { tables } = collectSchema(options.schema);
  const contracts: Record<string, { abi: any; address?: string }> = {};
  for (const [name, c] of Object.entries((config.contracts ?? {}) as Record<string, any>)) {
    const entry: { abi: any; address?: string } = { abi: c.abi };
    if (typeof c.address === "string") entry.address = c.address.toLowerCase();
    contracts[name] = entry;
  }

  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`indexer.${what} is not available before init()/start()`);
    return v;
  };

  const normalize = (chain: string, address: string) => {
    if (config.chains[chain]?.source.kind === "evm") return address.toLowerCase();
    return address;
  };

  async function doInit(): Promise<void> {
    db = createDb(config.database);
    await migrate(db, options.schema);
    obs = await initObservability(config.observability, { db, dbConfig: config.database });
    http = createHttpClient({ db, persist: config.cache?.http !== false, fetch: options.fetch, onCache: (hit) => obs!.metrics.recordCache("http", hit) });
    registry = new AddressRegistry(db, normalize);
    await registry.load();

    // Resolve "latest" start blocks once.
    const latest = new Map<string, number>();
    const usesLatest = JSON.stringify(config, configReplacer).includes('"latest"');
    if (usesLatest) {
      for (const [name, chain] of Object.entries(config.chains as Record<string, any>)) latest.set(name, await chain.source.getHeight());
    }
    const handled = new Set(handlers.keys());
    for (const [name, plan] of buildPlans(config, { handled, resolveLatest: (chain) => latest.get(chain)! })) plans.set(name, plan);

    if (config.cache?.source) {
      for (const plan of plans.values()) {
        const runnerRef: { current?: ChainRunner } = {};
        plan.config = {
          ...plan.config,
          source: cached(plan.config.source, {
            db,
            chain: plan.chain,
            finalizedHeight: () => runnerRef.current?.finalized,
            onEvent: (e) => e.type !== "store" && obs!.metrics.recordCache("source", e.type === "hit"),
          }) as any,
        };
        (plan as any).__runnerRef = runnerRef;
      }
    }

    for (const plan of plans.values()) {
      if (plan.contracts.length + plan.accounts.length === 0) {
        obs.log.warn("yail", `${plan.chain}: no handled contracts or accounts, chain will idle`);
      }
      const runner = new ChainRunner(
        {
          config,
          db,
          registry,
          obs,
          http,
          handlers,
          contracts,
          onError: options.onError,
          enqueueBackfill: async (chain, job) => {
            await jobRunners.get(chain)!.enqueue("backfill_address", job);
          },
          enqueueReindex: async (chain, fromBlock, toBlock) => {
            await jobRunners.get(chain)!.enqueue("reindex_range", { fromBlock, toBlock });
          },
        },
        plan,
      );
      (plan as any).__runnerRef && ((plan as any).__runnerRef.current = runner);
      runners.set(plan.chain, runner);
      jobRunners.set(plan.chain, new JobRunner({ db, registry, obs, tables, concurrency: config.indexing?.jobConcurrency ?? 2 }, runner));
    }
    for (const runner of runners.values()) await runner.init();
    for (const j of jobRunners.values()) await j.poll();
    obs.log.info("yail", `initialized ${runners.size} chain(s): ${[...runners.values()].map((r) => `${r.chain}@${r.cursor}`).join(", ")}`);
  }

  const indexer: Indexer<C> = {
    config,
    schema: options.schema,
    get db() {
      return need(db, "db");
    },
    get observability() {
      return need(obs, "observability");
    },
    get http() {
      return need(http, "http");
    },
    internals: { plans, runners, jobs: jobRunners, registry: undefined as unknown as AddressRegistry },
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler as Handler);
      handlers.set(name, list);
      return indexer;
    },
    async init() {
      initPromise ??= doInit().then(() => {
        (indexer.internals as any).registry = registry;
      });
      await initPromise;
    },
    async migrate(migrateOptions) {
      db ??= createDb(config.database);
      await migrate(db, options.schema, migrateOptions);
    },
    async start(startOptions = {}) {
      await indexer.init();
      const o = need(obs, "observability");
      for (const j of jobRunners.values()) j.start();
      if (startOptions.server !== false && config.server?.port !== false) {
        const { startServer } = await import("../server/api.js");
        serverHandle = await startServer(indexer, { port: config.server?.port ?? 42069, hostname: config.server?.hostname });
      }
      const loops = [...runners.values()].map((r) => r.runLoop({ once: false }));
      try {
        await Promise.all(loops);
      } catch (err) {
        o.log.error("yail", `stopping: ${(err as Error).message}`);
        await indexer.stop();
        throw err;
      }
    },
    async run() {
      await indexer.init();
      for (const j of jobRunners.values()) j.start();
      const o = need(obs, "observability");
      try {
        await Promise.all([...runners.values()].map((r) => r.runLoop({ once: true })));
        o.log.info({ event: "run_phase", phase: "chains_caught_up" });
        await Promise.all([...jobRunners.values()].map((j) => j.drain()));
        o.log.info({ event: "run_phase", phase: "jobs_drained" });
        // Backfills may have registered more addresses or the head may have moved; settle once more.
        await Promise.all([...runners.values()].map((r) => r.runLoop({ once: true })));
        await Promise.all([...jobRunners.values()].map((j) => j.drain()));
        o.log.info({ event: "run_phase", phase: "settled" });
      } finally {
        await indexer.stop();
        o.log.info({ event: "run_phase", phase: "stopped" });
      }
    },
    async stop() {
      for (const r of runners.values()) r.stop();
      await Promise.all([...jobRunners.values()].map((j) => j.stop()));
      await serverHandle?.close();
      serverHandle = undefined;
    },
    addresses: {
      async register(input) {
        await indexer.init();
        const list = toArray(input).flatMap((i) => {
          let chains = [...plans.values()].filter((p) => p.sets.has(i.set)).map((p) => p.chain);
          if (i.chain) chains = [i.chain];
          if (chains.length === 0) throw new Error(`address set "${i.set}" is not used by any chain`);
          return chains.map((chain) => ({ set: i.set, chain, address: i.address, fromBlock: i.fromBlock ?? plans.get(chain)!.sets.get(i.set) ?? 0, meta: i.meta }));
        });
        const rows = await need(registry, "addresses").register(list);
        for (const r of runners.values()) r.wake();
        return rows;
      },
      list(filter) {
        return need(registry, "addresses").list(filter);
      },
      has(set, chain, address) {
        return need(registry, "addresses").has(set, chain, address);
      },
    },
    async reindex(request) {
      await indexer.init();
      const j = jobRunners.get(request.chain);
      if (!j) throw new Error(`unknown chain "${request.chain}"`);
      if (request.scope !== undefined) {
        if (request.value === undefined) throw new Error("reindex: value is required with scope");
        return [await j.enqueue("reindex_scope", { scope: request.scope, value: request.value })];
      }
      if (request.fromBlock === undefined || request.toBlock === undefined) throw new Error("reindex: fromBlock and toBlock (or scope + value) are required");
      return [await j.enqueue("reindex_range", { fromBlock: request.fromBlock, toBlock: request.toBlock })];
    },
    async status() {
      await indexer.init();
      const snap = need(obs, "observability").metrics.snapshot();
      const chains: StatusSnapshot["chains"] = {};
      for (const [name, r] of runners) {
        const s = snap.chains[name] ?? { cursor: r.cursor, head: r.head, finalized: r.finalized, lagBlocks: 0, blocksIndexed: 0, eventsProcessed: 0, batches: 0, errors: 0, lastBatchMs: 0, caughtUp: r.caughtUp };
        chains[name] = { ...s, cursor: r.cursor, head: r.head, finalized: r.finalized, caughtUp: r.caughtUp, running: r.running, error: r.error?.message, pendingJobs: jobRunners.get(name)?.pending ?? 0 };
      }
      return { chains, addresses: await need(registry, "addresses").counts(), counters: snap.counters as any };
    },
  };
  return indexer;
}

function configReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return undefined;
  return value;
}

export { isAddressSet, isFactory };
