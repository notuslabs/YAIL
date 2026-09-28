import { createClient, type ClickHouseClient } from "@clickhouse/client";
import type { InferRow, InsertRow, Table } from "../schema/table.js";
import { renderSql, sql, type SqlFragment } from "./sql.js";
import { deserializeRow, serializeRow, type RowMeta } from "./serialize.js";

export interface DatabaseConfig {
  /** ClickHouse HTTP URL, e.g. http://localhost:8123. Credentials may be embedded (http://user:pass@host:8123). */
  url: string;
  /** Database name. Created by `migrate` if missing. Default `default`. */
  database?: string;
  username?: string;
  password?: string;
  /** Extra ClickHouse settings applied to every request. */
  settings?: Record<string, string | number | boolean>;
  /** Request timeout in ms. Default 60s. */
  requestTimeout?: number;
}

export interface QueryOptions {
  settings?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}

/**
 * Thin, typed ClickHouse client. This is the same object handlers receive as
 * `context.db` and the same one an API can use to read what the indexer wrote.
 */
export interface Db {
  readonly client: ClickHouseClient;
  readonly database: string;
  /** Run a SELECT and return JSONEachRow rows. Prefer `sql` fragments for parameters. */
  query<T = Record<string, unknown>>(query: SqlFragment | string, options?: QueryOptions): Promise<T[]>;
  /** Run a statement that returns no rows (DDL, DELETE, INSERT ... SELECT). */
  command(query: SqlFragment | string, options?: QueryOptions): Promise<void>;
  /** Typed rows of a schema table. `where` is appended after `FROM table [FINAL]`. */
  rows<T extends Table<any>>(table: T, where?: SqlFragment, options?: { final?: boolean } & QueryOptions): Promise<Array<InferRow<T>>>;
  /** Find one row by (a subset of) its ORDER BY key. Reads with FINAL so re-inserted rows collapse. */
  find<T extends Table<any>>(table: T, key: Partial<InferRow<T>>): Promise<InferRow<T> | null>;
  /** Immediate (unbuffered) insert. Handlers should use `context.db.insert` which is batched. */
  insert<T extends Table<any>>(table: T): { values(rows: InsertRow<T> | InsertRow<T>[], meta?: RowMeta): Promise<void> };
  /** Low-level insert of pre-serialized JSONEachRow rows. */
  insertRaw(tableName: string, rows: Record<string, unknown>[], options?: QueryOptions): Promise<void>;
  /** Create the configured database if missing (uses a connection bound to `default`). */
  createDatabase(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

const DEFAULT_SETTINGS = {
  date_time_output_format: "iso",
  output_format_json_quote_64bit_integers: 1,
  input_format_import_nested_json: 0,
} as const;

export function createDb(config: DatabaseConfig): Db {
  const parsed = new URL(config.url);
  const username = config.username ?? (parsed.username ? decodeURIComponent(parsed.username) : "default");
  const password = config.password ?? (parsed.password ? decodeURIComponent(parsed.password) : "");
  const database = config.database ?? (parsed.pathname.replace(/^\//, "") || "default");
  parsed.username = "";
  parsed.password = "";
  parsed.pathname = "/";

  const client = createClient({
    url: parsed.toString(),
    username,
    password,
    database,
    request_timeout: config.requestTimeout ?? 60_000,
    clickhouse_settings: { ...DEFAULT_SETTINGS, ...(config.settings ?? {}) } as any,
  });

  const db: Db = {
    client,
    database,
    async query(query, options) {
      const { text, params } = renderSql(query);
      const rs = await client.query({
        query: text,
        query_params: params,
        format: "JSONEachRow",
        clickhouse_settings: options?.settings as any,
        abort_signal: options?.signal,
      });
      return (await rs.json()) as any[];
    },
    async command(query, options) {
      const { text, params } = renderSql(query);
      await client.command({
        query: text,
        query_params: params,
        clickhouse_settings: options?.settings as any,
        abort_signal: options?.signal,
      });
    },
    async rows(table, where, options) {
      const final = options?.final ?? true;
      const q = sql`SELECT * FROM ${table}${sql.raw(final ? " FINAL" : "")} ${where ?? sql.empty()}`;
      const raw = await db.query(q, options);
      return raw.map((r) => deserializeRow(table, r)) as any;
    },
    async find(table, key) {
      const conds = Object.entries(key).map(([k, v]) => sql`${sql.identifier(table.columnName(k))} = ${v as any}`);
      if (conds.length === 0) throw new Error("find() requires at least one key column");
      const rows = await db.rows(table, sql`WHERE ${sql.join(conds, " AND ")} LIMIT 1`);
      return rows[0] ?? null;
    },
    insert(table) {
      return {
        async values(rows, meta) {
          const list = Array.isArray(rows) ? rows : [rows];
          if (list.length === 0) return;
          await db.insertRaw(
            table.name,
            list.map((r) => serializeRow(table, r as Record<string, unknown>, meta)),
          );
        },
      };
    },
    async insertRaw(tableName, rows, options) {
      if (rows.length === 0) return;
      await client.insert({
        table: tableName,
        values: rows,
        format: "JSONEachRow",
        clickhouse_settings: options?.settings as any,
        abort_signal: options?.signal,
      });
    },
    async createDatabase() {
      const admin = createClient({ url: parsed.toString(), username, password, database: "default", request_timeout: config.requestTimeout ?? 60_000 });
      try {
        await admin.command({ query: `CREATE DATABASE IF NOT EXISTS \`${database}\`` });
      } finally {
        await admin.close();
      }
    },
    async ping() {
      const r = await client.ping();
      return r.success;
    },
    async close() {
      await client.close();
    },
  };
  return db;
}
