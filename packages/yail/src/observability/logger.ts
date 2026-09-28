import { createLogger, initLogger, log as evlog, type DrainContext, type DrainFn, type RequestLogger } from "evlog";
import { createMemoryDrain, readMemoryLogs } from "evlog/memory";
import { createOTLPDrain } from "evlog/otlp";
import { createClickHouseDrain } from "evlog/clickhouse";
import type { DatabaseConfig, Db } from "../db/client.js";
import type { ObservabilityConfig } from "../config/types.js";
import { Metrics } from "./metrics.js";

export type Log = typeof evlog;
export type WideLogger = RequestLogger;

export interface Observability {
  readonly config: Required<Pick<ObservabilityConfig, "serviceName" | "batchEvents">> & ObservabilityConfig;
  readonly log: Log;
  readonly metrics: Metrics;
  /** Start a wide event (one per batch/job). Call `.emit()` when done. */
  wide(context: Record<string, unknown>): WideLogger;
  /** Recent wide events from the in-memory ring buffer (served on /_evlog/logs and handy in tests). */
  recentEvents(limit?: number): ReturnType<typeof readMemoryLogs>;
}

let initialized = false;

const LOGS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS {db}.\`_yail_logs\` (
  timestamp DateTime64(3),
  level LowCardinality(String),
  service LowCardinality(String),
  environment LowCardinality(String),
  request_id String,
  trace_id String,
  span_id String,
  method LowCardinality(String),
  path String,
  status Nullable(UInt16),
  duration String,
  duration_ms UInt32,
  error_name String,
  error_message String,
  data String CODEC(ZSTD(3))
) ENGINE = MergeTree PARTITION BY toYYYYMM(timestamp) ORDER BY (service, timestamp) TTL toDateTime(timestamp) + INTERVAL 30 DAY`;

export async function initObservability(config: ObservabilityConfig = {}, deps: { db?: Db; dbConfig?: DatabaseConfig } = {}): Promise<Observability> {
  const serviceName = config.serviceName ?? "yail";
  const drains: DrainFn[] = [createMemoryDrain({ store: "yail", maxEvents: 2000 })];
  const otlpEndpoint = config.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? process.env.OTLP_ENDPOINT;
  if (otlpEndpoint) {
    drains.push(createOTLPDrain({ endpoint: otlpEndpoint, serviceName, headers: config.otlpHeaders, recordShape: "compact" }));
  }
  if (config.logsToClickHouse && deps.db && deps.dbConfig) {
    await deps.db.command(LOGS_TABLE_DDL.replace("{db}", `\`${deps.db.database}\``));
    const u = new URL(deps.dbConfig.url);
    const username = deps.dbConfig.username ?? (u.username ? decodeURIComponent(u.username) : "default");
    const password = deps.dbConfig.password ?? (u.password ? decodeURIComponent(u.password) : "");
    u.username = "";
    u.password = "";
    u.pathname = "/";
    drains.push(createClickHouseDrain({ endpoint: u.toString().replace(/\/$/, ""), database: deps.db.database, table: "_yail_logs", username, password }));
  }
  const drain = async (ctx: DrainContext) => {
    await Promise.allSettled(drains.map((d) => d(ctx)));
  };
  if (!initialized) {
    initLogger({
      env: { service: serviceName, environment: process.env.NODE_ENV ?? "development" },
      pretty: config.pretty ?? process.env.NODE_ENV !== "production",
      minLevel: config.logLevel,
      drain,
      _suppressDrainWarning: true,
    });
    initialized = true;
  }
  const metrics = new Metrics(serviceName);
  return {
    config: { ...config, serviceName, batchEvents: config.batchEvents ?? true },
    log: evlog,
    metrics,
    wide(context) {
      return createLogger(context);
    },
    recentEvents(limit = 100) {
      return readMemoryLogs({ store: "yail", limit });
    },
  };
}

/** Structured error with the evlog fields (`why`, `fix`) so alerts explain themselves. */
export { createError } from "evlog";
