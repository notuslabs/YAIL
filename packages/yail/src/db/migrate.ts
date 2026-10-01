import { isMaterializedView, isTable, isView, materializedViewDdl, materializedViewPopulateSql, tableDdl, viewDdl, type MaterializedView, type Table, type View } from "../schema/index.js";
import type { Db } from "./client.js";
import { INTERNAL_TABLES } from "./internal.js";
import { isSqlFragment, type SqlFragment } from "./sql.js";

export type SchemaModule = Record<string, unknown>;

type SchemaItem = Table<any> | MaterializedView | View;

export function collectSchema(schema: SchemaModule | ReadonlyArray<SchemaItem>): {
  tables: Table<any>[];
  views: MaterializedView[];
  /** Plain views, each after the views it reads. */
  plainViews: View[];
} {
  let values: unknown[];
  if (Array.isArray(schema)) values = [...schema];
  else values = Object.values(schema as SchemaModule);
  const tables: Table<any>[] = [];
  const views: MaterializedView[] = [];
  const plainViews = inCreationOrder(values.filter(isView));
  const seen = new Set<string>();
  for (const v of values) {
    if (isTable(v) && !seen.has(v.name)) {
      seen.add(v.name);
      tables.push(v);
    } else if (isMaterializedView(v)) {
      views.push(v);
      if (!seen.has(v.to.name)) {
        seen.add(v.to.name);
        tables.push(v.to);
      }
    }
  }
  return { tables, views, plainViews };
}

/** Views a query interpolates, directly or through nested fragments. */
function viewsIn(fragment: SqlFragment): View[] {
  return [...fragment.values.filter(isView), ...fragment.values.filter(isSqlFragment).flatMap(viewsIn)];
}

/** Dependencies first, whatever the export order (`import * as schema` sorts names). */
function inCreationOrder(views: View[]): View[] {
  const ordered = new Set<View>();
  const visit = (view: View) => {
    if (ordered.has(view)) return;
    viewsIn(view.query).forEach(visit);
    ordered.add(view);
  };
  views.forEach(visit);
  return [...ordered];
}

export interface MigrateOptions {
  /** Re-run each materialized view's SELECT as INSERT into its target (backfills MVs over existing data). */
  populate?: boolean;
  /** Drop and recreate user tables/views (dev only). Internal tables are kept. */
  reset?: boolean;
  log?: (msg: string) => void;
}

/**
 * Create the database, internal bookkeeping tables, user tables and
 * materialized views. Idempotent (`CREATE ... IF NOT EXISTS`).
 */
export async function migrate(db: Db, schema: SchemaModule | ReadonlyArray<SchemaItem>, options: MigrateOptions = {}): Promise<void> {
  const log = options.log ?? (() => {});
  const { tables, views, plainViews } = collectSchema(schema);

  await db.createDatabase();

  for (const t of INTERNAL_TABLES) {
    await db.command(tableDdl(t, db.database));
  }

  if (options.reset) {
    for (const v of [...plainViews].reverse()) {
      log(`drop view ${v.name}`);
      await db.command(`DROP VIEW IF EXISTS \`${db.database}\`.\`${v.name}\``);
    }
    for (const v of views) {
      log(`drop view ${v.name}`);
      await db.command(`DROP VIEW IF EXISTS \`${db.database}\`.\`${v.name}\``);
    }
    for (const t of tables) {
      log(`drop table ${t.name}`);
      await db.command(`DROP TABLE IF EXISTS \`${db.database}\`.\`${t.name}\``);
    }
  }

  for (const t of tables) {
    log(`create table ${t.name}`);
    await db.command(tableDdl(t, db.database));
  }
  for (const v of views) {
    log(`create materialized view ${v.name}`);
    await db.command(materializedViewDdl(v, db.database));
  }
  for (const v of plainViews) {
    log(`create view ${v.name}`);
    await db.command(viewDdl(v, db.database));
  }
  if (options.populate) {
    for (const v of views) {
      log(`populate ${v.name} -> ${v.to.name}`);
      await db.command(materializedViewPopulateSql(v, db.database));
    }
  }
}

/** Ordered DDL statements, useful for review or applying with another tool. */
export function schemaDdl(schema: SchemaModule | ReadonlyArray<SchemaItem>, database?: string): string[] {
  const { tables, views, plainViews } = collectSchema(schema);
  return [
    ...INTERNAL_TABLES.map((t) => tableDdl(t, database)),
    ...tables.map((t) => tableDdl(t, database)),
    ...views.map((v) => materializedViewDdl(v, database)),
    ...plainViews.map((v) => viewDdl(v, database)),
  ];
}
