import { randomUUID } from "node:crypto";
import { createDb, type DatabaseConfig } from "../db/client.js";

export { fixtureSource, readFixture, writeFixture, recordEvmFixture, recordBitcoinFixture, recordSolanaFixture } from "../sources/fixture.js";
export type { Fixture, EvmFixture, BitcoinFixture, SolanaFixture } from "../sources/fixture.js";
export { readMemoryLogs } from "evlog/memory";
export { seedCache } from "../cache/cached.js";

export interface TestClickHouse {
  /** Base HTTP URL with credentials, e.g. http://default:pass@localhost:32768 */
  url: string;
  /** `database` config for an isolated database (created by migrate). */
  database(config?: Partial<DatabaseConfig>): DatabaseConfig;
  /** Stops the container, or on a `YAIL_TEST_CLICKHOUSE_URL` server drops every database `database()` named, views included. */
  stop(): Promise<void>;
}

let shared: Promise<TestClickHouse> | undefined;

/**
 * A ClickHouse for tests. Uses `YAIL_TEST_CLICKHOUSE_URL` when set (a running
 * server), otherwise starts a `clickhouse/clickhouse-server` container via
 * testcontainers (needs Docker). One instance is shared per process until it is stopped.
 */
export function startTestClickHouse(options: { image?: string } = {}): Promise<TestClickHouse> {
  shared ??= (async () => {
    const envUrl = process.env.YAIL_TEST_CLICKHOUSE_URL;
    if (envUrl) return make(envUrl, dropDatabases);
    let ClickHouseContainer: (typeof import("@testcontainers/clickhouse"))["ClickHouseContainer"];
    try {
      ({ ClickHouseContainer } = await import("@testcontainers/clickhouse"));
    } catch (cause) {
      throw new Error(
        "startTestClickHouse(): install the optional peer dependency `@testcontainers/clickhouse` (and have Docker running), or point YAIL_TEST_CLICKHOUSE_URL at a running ClickHouse.",
        { cause },
      );
    }
    const container = await new ClickHouseContainer(options.image ?? process.env.YAIL_TEST_CLICKHOUSE_IMAGE ?? "clickhouse/clickhouse-server:25.8")
      .withUsername("default")
      .withPassword("yail")
      .start();
    return make(container.getConnectionUrl(), () => container.stop().then(() => {}));
  })();
  return shared;
}

function make(url: string, stop: (url: string, databases: string[]) => Promise<void>): TestClickHouse {
  const u = new URL(url);
  let auth = "";
  if (u.username) auth = `${u.username}:${u.password}@`;
  const base = `${u.protocol}//${auth}${u.host}`;
  const databases: string[] = [];
  return {
    url: base,
    database(config) {
      const database = `yail_test_${randomUUID().slice(0, 8)}`;
      databases.push(database);
      return { url: base, database, ...config };
    },
    stop: () => {
      shared = undefined;
      return stop(base, databases);
    },
  };
}

async function dropDatabases(url: string, databases: string[]): Promise<void> {
  const db = createDb({ url });
  try {
    for (const database of databases) await db.command(`DROP DATABASE IF EXISTS \`${database}\` SYNC`);
  } finally {
    await db.close();
  }
}
