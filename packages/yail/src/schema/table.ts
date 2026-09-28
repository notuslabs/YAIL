import type { Column } from "./column.js";

export type Columns = Record<string, Column<any, boolean, boolean>>;

export type TableEngine =
  | "MergeTree"
  | "ReplacingMergeTree"
  | "SummingMergeTree"
  | "AggregatingMergeTree"
  | "CollapsingMergeTree"
  | "ReplicatedMergeTree"
  | "ReplicatedReplacingMergeTree";

export interface TableOptions<C extends Columns> {
  /**
   * Sorting key / primary key. Rows with the same key are deduplicated on
   * ReplacingMergeTree (the default engine), which is what makes re-indexing
   * idempotent. Choose the natural identity of a row (e.g. chain + tx + logIndex).
   */
  orderBy: ReadonlyArray<keyof C & string>;
  /** Raw ClickHouse PARTITION BY expression, e.g. `toYYYYMM(block_time)`. */
  partitionBy?: string;
  /** Defaults to ReplacingMergeTree versioned by the internal `_yail_version` column. */
  engine?: TableEngine;
  /** Extra engine args (e.g. summed columns for SummingMergeTree). Not needed for Replacing. */
  engineArgs?: string[];
  /** Raw TTL expression. */
  ttl?: string;
  /** Extra SETTINGS for the table. */
  settings?: Record<string, string | number>;
  /**
   * Entity scopes for targeted re-indexing. Keys are scope names (e.g. `wallet`,
   * `pool`) and values are the column holding the entity id. `yail reindex
   * --scope wallet=0xabc` deletes matching rows in every table declaring that scope.
   */
  scopes?: Record<string, keyof C & string>;
  /**
   * Whether to add the hidden bookkeeping columns `_yail_chain`, `_yail_block`,
   * `_yail_version`. Required for range re-indexing and versioned dedup. Default true.
   */
  indexMeta?: boolean;
  /** Optional column name overrides: TS key -> ClickHouse column name. Defaults to snake_case. */
  columnNames?: Partial<Record<keyof C & string, string>>;
}

export interface Table<C extends Columns = Columns> {
  readonly __brand: "yail.table";
  readonly name: string;
  readonly columns: C;
  readonly options: TableOptions<C>;
  /** TS key -> ClickHouse column name. */
  readonly columnName: (key: keyof C & string) => string;
  readonly columnKeys: ReadonlyArray<keyof C & string>;
  toString(): string;
}

type OptionalKeys<C extends Columns> = {
  [K in keyof C]: C[K]["isNullable"] extends true ? K : C[K]["hasDefault"] extends true ? K : never;
}[keyof C];
type RequiredKeys<C extends Columns> = Exclude<keyof C, OptionalKeys<C>>;

type ColType<Col> = Col extends Column<infer T, infer N, boolean> ? (N extends true ? T | null : T) : never;

/** Row type accepted by `db.insert(table).values(row)`. */
export type InsertRow<T extends Table<any>> = T extends Table<infer C>
  ? { [K in RequiredKeys<C>]: ColType<C[K]> } & { [K in OptionalKeys<C>]?: ColType<C[K]> | undefined }
  : never;

/** Row type returned by `db.rows(table, ...)`. */
export type InferRow<T extends Table<any>> = T extends Table<infer C> ? { [K in keyof C]: ColType<C[K]> } : never;

export const INDEX_META_COLUMNS = {
  chain: "_yail_chain",
  block: "_yail_block",
  version: "_yail_version",
} as const;

export function snakeCase(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();
}

export function table<C extends Columns>(name: string, columns: C, options: TableOptions<C>): Table<C> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`Invalid table name "${name}"`);
  for (const key of options.orderBy) {
    if (!(key in columns)) throw new Error(`Table "${name}": orderBy column "${key}" does not exist`);
  }
  for (const [scope, col] of Object.entries(options.scopes ?? {})) {
    if (!(col in columns)) throw new Error(`Table "${name}": scope "${scope}" points to unknown column "${col}"`);
  }
  const overrides: Partial<Record<keyof C & string, string>> = options.columnNames ?? {};
  const columnName = (key: keyof C & string) => overrides[key] ?? snakeCase(key);
  return {
    __brand: "yail.table",
    name,
    columns,
    options: { indexMeta: true, engine: "ReplacingMergeTree", ...options },
    columnName,
    columnKeys: Object.keys(columns) as Array<keyof C & string>,
    toString: () => name,
  };
}

export function isTable(v: unknown): v is Table {
  return typeof v === "object" && v !== null && (v as Table).__brand === "yail.table";
}
