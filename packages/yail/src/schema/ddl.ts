import { columnTypeSql } from "./column.js";
import { INDEX_META_COLUMNS, type Table } from "./table.js";
import type { MaterializedView, View } from "./view.js";
import { qualify, renderSql } from "../db/sql.js";

export { qualify };

export function tableDdl(table: Table<any>, database?: string): string {
  const cols: string[] = [];
  for (const key of table.columnKeys) {
    const col = table.columns[key]!;
    let line = `\`${table.columnName(key)}\` ${columnTypeSql(col)}`;
    if (col.hasDefault && col.defaultSql) line += ` DEFAULT ${col.defaultSql}`;
    if (col.codecSql) line += ` CODEC(${col.codecSql})`;
    cols.push(line);
  }
  const meta = table.options.indexMeta !== false;
  if (meta) {
    cols.push(`\`${INDEX_META_COLUMNS.chain}\` LowCardinality(String) DEFAULT ''`);
    cols.push(`\`${INDEX_META_COLUMNS.block}\` UInt64 DEFAULT 0`);
    cols.push(`\`${INDEX_META_COLUMNS.version}\` UInt64 DEFAULT 0`);
  }
  const engine = table.options.engine ?? "ReplacingMergeTree";
  let engineArgs = table.options.engineArgs ?? [];
  if ((engine === "ReplacingMergeTree" || engine === "ReplicatedReplacingMergeTree") && engineArgs.length === 0 && meta) {
    engineArgs = [INDEX_META_COLUMNS.version];
  }
  const orderBy = table.options.orderBy.map((k) => `\`${table.columnName(k)}\``).join(", ");
  const parts = [
    `CREATE TABLE IF NOT EXISTS ${qualify(table.name, database)} (\n  ${cols.join(",\n  ")}\n)`,
    `ENGINE = ${engine}(${engineArgs.join(", ")})`,
  ];
  if (table.options.partitionBy) parts.push(`PARTITION BY ${table.options.partitionBy}`);
  parts.push(`ORDER BY (${orderBy})`);
  if (table.options.ttl) parts.push(`TTL ${table.options.ttl}`);
  if (table.options.settings && Object.keys(table.options.settings).length > 0) {
    parts.push(
      `SETTINGS ${Object.entries(table.options.settings)
        .map(([k, v]) => `${k} = ${settingValue(v)}`)
        .join(", ")}`,
    );
  }
  return parts.join("\n");
}

export function materializedViewDdl(view: MaterializedView, database?: string): string {
  const { text } = renderSql(view.query, { inline: true, database });
  return `CREATE MATERIALIZED VIEW IF NOT EXISTS ${qualify(view.name, database)} TO ${qualify(view.to.name, database)} AS\n${text}`;
}

/** `CREATE OR REPLACE`: a plain view holds no data, so every migrate applies its current query. */
export function viewDdl(view: View, database?: string): string {
  const { text } = renderSql(view.query, { inline: true, database });
  return `CREATE OR REPLACE VIEW ${qualify(view.name, database)} AS\n${text}`;
}

/** One-off backfill of a materialized view's target from existing source data. */
export function materializedViewPopulateSql(view: MaterializedView, database?: string): string {
  const { text } = renderSql(view.query, { inline: true, database });
  return `INSERT INTO ${qualify(view.to.name, database)}\n${text}`;
}

function settingValue(v: string | number): string {
  if (typeof v === "number") return String(v);
  return `'${v}'`;
}
