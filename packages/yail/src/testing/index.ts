import { randomUUID } from "node:crypto";
import type { DatabaseConfig } from "../db/client.js";

export { fixtureSource, readFixture, writeFixture, recordEvmFixture, recordBitcoinFixture } from "../sources/fixture.js";
export type { Fixture, EvmFixture, BitcoinFixture } from "../sources/fixture.js";
export { readMemoryLogs } from "evlog/memory";

export interface TestClickHouse {
  /** Base HTTP URL with credentials, e.g. http://default:pass@localhost:32768 */
  url: string;
  /** `database` config for an isolated database (created by migrate). */
  database(config?: Partial<DatabaseConfig>): DatabaseConfig;
  stop(): Promise<void>;
}

let shared: Promise<TestClickHouse> | undefined;

/**
 * A ClickHouse for tests. Uses `YAIL_TEST_CLICKHOUSE_URL` when set (a running
 * server), otherwise starts a `clickhouse/clickhouse-server` container via
 * testcontainers (needs Docker). One instance is shared per process.
 */
export function startTestClickHouse(options: { image?: string } = {}): Promise<TestClickHouse> {
  shared ??= (async () => {
    const envUrl = process.env.YAIL_TEST_CLICKHOUSE_URL;
    if (envUrl) return make(envUrl, async () => {});
    const { ClickHouseContainer } = await import("@testcontainers/clickhouse");
    const container = await new ClickHouseContainer(options.image ?? process.env.YAIL_TEST_CLICKHOUSE_IMAGE ?? "clickhouse/clickhouse-server:25.8")
      .withUsername("default")
      .withPassword("yail")
      .start();
    return make(container.getConnectionUrl(), () => container.stop().then(() => {}));
  })();
  return shared;
}

function make(url: string, stop: () => Promise<void>): TestClickHouse {
  const u = new URL(url);
  const base = `${u.protocol}//${u.username ? `${u.username}:${u.password}@` : ""}${u.host}`;
  return {
    url: base,
    database(config) {
      return { url: base, database: `yail_test_${randomUUID().slice(0, 8)}`, ...config };
    },
    stop,
  };
}
