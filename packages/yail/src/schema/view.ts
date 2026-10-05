import type { Table } from "./table.js";
import type { SqlFragment } from "../db/sql.js";
import { toArray } from "../util.js";

/**
 * A refreshable materialized view re-runs its whole SELECT on a schedule instead of on every insert, so it can join
 * across rows and tables (the ClickHouse way to keep a derived table that an insert-time view cannot express).
 * With `append` the result is added to the target (a ReplacingMergeTree key dedups it) rather than replacing it,
 * so `query` can be limited to a recent window; `populate` is then the unwindowed query `yail migrate --populate` runs once.
 */
export interface Refresh {
  /** ClickHouse refresh schedule, e.g. `EVERY 1 HOUR`, `EVERY 1 DAY OFFSET 2 HOUR`. */
  schedule: string;
  append?: boolean;
  populate?: SqlFragment;
}

export interface MaterializedView {
  readonly __brand: "yail.materializedView";
  readonly name: string;
  /** Target table the view writes into (must be created, use `table()`). */
  readonly to: Table<any>;
  /** The SELECT that transforms inserts into rows of `to` (or, with `refresh`, recomputes them on a schedule). */
  readonly query: SqlFragment;
  /** Source table(s), used for `yail migrate --populate` ordering and docs. */
  readonly from: ReadonlyArray<Table<any>>;
  readonly refresh?: Refresh;
}

export function materializedView(
  name: string,
  def: { to: Table<any>; from: Table<any> | ReadonlyArray<Table<any>>; query: SqlFragment; refresh?: Refresh },
): MaterializedView {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`Invalid view name "${name}"`);
  return {
    __brand: "yail.materializedView",
    name,
    to: def.to,
    query: def.query,
    from: toArray<Table<any>>(def.from),
    refresh: def.refresh,
  };
}

export function isMaterializedView(v: unknown): v is MaterializedView {
  return typeof v === "object" && v !== null && (v as MaterializedView).__brand === "yail.materializedView";
}

/** A plain ClickHouse view: a named SELECT run on every read, so it never drifts from the tables it reads. */
export interface View {
  readonly __brand: "yail.view";
  readonly name: string;
  readonly query: SqlFragment;
}

export function view(name: string, query: SqlFragment): View {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`Invalid view name "${name}"`);
  return { __brand: "yail.view", name, query };
}

export function isView(v: unknown): v is View {
  return typeof v === "object" && v !== null && (v as View).__brand === "yail.view";
}
