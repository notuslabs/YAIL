import type { Column } from "../schema/column.js";
import { INDEX_META_COLUMNS, type Table } from "../schema/table.js";
import { formatDateTime64 } from "./sql.js";

export interface RowMeta {
  chain?: string;
  block?: number | bigint;
  version?: number | bigint;
}

/** Convert a TS row into the JSONEachRow representation ClickHouse accepts. */
export function serializeRow(table: Table<any>, row: Record<string, unknown>, meta?: RowMeta): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of table.columnKeys) {
    const col = table.columns[key]!;
    const value = row[key];
    if (value === undefined) {
      if (col.hasDefault || col.isNullable) continue;
      throw new Error(`Table "${table.name}": missing required column "${key}"`);
    }
    out[table.columnName(key)] = serializeValue(col, value, `${table.name}.${key}`);
  }
  if (table.options.indexMeta !== false) {
    out[INDEX_META_COLUMNS.chain] = meta?.chain ?? "";
    out[INDEX_META_COLUMNS.block] = meta?.block === undefined ? 0 : Number(meta.block);
    out[INDEX_META_COLUMNS.version] = meta?.version === undefined ? "0" : meta.version.toString();
  }
  return out;
}

export function serializeValue(col: Column, value: unknown, path: string): unknown {
  if (value === null) {
    if (!col.isNullable) throw new Error(`Column ${path} is not nullable`);
    return null;
  }
  switch (col.kind) {
    case "string":
    case "hash":
      return String(value);
    case "address":
      return typeof value === "string" && value.startsWith("0x") ? value.toLowerCase() : String(value);
    case "bool":
      return Boolean(value);
    case "int":
    case "float":
      return typeof value === "bigint" ? Number(value) : (value as number);
    case "bigint": {
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "number") return Number.isInteger(value) ? String(value) : Math.trunc(value).toString();
      if (typeof value === "string") return BigInt(value).toString();
      throw new Error(`Column ${path}: expected bigint, got ${typeof value}`);
    }
    case "date": {
      const d = value instanceof Date ? value : new Date(typeof value === "number" && value < 1e12 ? value * 1000 : (value as any));
      if (Number.isNaN(d.getTime())) throw new Error(`Column ${path}: invalid date ${String(value)}`);
      if (col.chType === "Date") return d.toISOString().slice(0, 10);
      if (col.chType.startsWith("DateTime64")) return formatDateTime64(d);
      return Math.floor(d.getTime() / 1000);
    }
    case "enum":
      return String(value);
    case "json":
      return typeof value === "string" ? value : JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    case "array":
      return (value as unknown[]).map((v) => serializeValue(col.items!, v, path + "[]"));
  }
}

/** Parse a JSONEachRow row (with `date_time_output_format='iso'`) back into TS values. */
export function deserializeRow<T extends Table<any>>(table: T, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of table.columnKeys) {
    const col = table.columns[key]!;
    const v = raw[table.columnName(key)];
    out[key] = deserializeValue(col, v);
  }
  return out;
}

export function deserializeValue(col: Column, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (col.kind) {
    case "bigint":
      return BigInt(v as string | number);
    case "int":
    case "float":
      return typeof v === "string" ? Number(v) : v;
    case "bool":
      return typeof v === "string" ? v === "true" || v === "1" : Boolean(v);
    case "date": {
      if (typeof v === "number") return new Date(v * 1000);
      const s = String(v);
      // 'iso' output: 2024-01-01T00:00:00Z or 2024-01-01 (Date); 'simple': 2024-01-01 00:00:00
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + "T00:00:00Z");
      if (s.includes("T")) return new Date(s);
      return new Date(s.replace(" ", "T") + "Z");
    }
    case "json":
      return typeof v === "string" ? JSON.parse(v) : v;
    case "array":
      return (v as unknown[]).map((x) => deserializeValue(col.items!, x));
    default:
      return v;
  }
}
