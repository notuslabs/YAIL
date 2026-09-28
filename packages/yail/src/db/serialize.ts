import type { Column } from "../schema/column.js";
import { INDEX_META_COLUMNS, type Table } from "../schema/table.js";
import { formatDateTime64 } from "./sql.js";
import { bigintReplacer } from "../util.js";

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
    let block = 0;
    if (meta?.block !== undefined) block = Number(meta.block);
    let version = "0";
    if (meta?.version !== undefined) version = meta.version.toString();
    out[INDEX_META_COLUMNS.block] = block;
    out[INDEX_META_COLUMNS.version] = version;
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
    case "address": {
      const text = String(value);
      if (text.startsWith("0x")) return text.toLowerCase();
      return text;
    }
    case "bool":
      return Boolean(value);
    case "int":
    case "float":
      if (typeof value === "bigint") return Number(value);
      return value as number;
    case "bigint": {
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "number") return Math.trunc(value).toString();
      if (typeof value === "string") return BigInt(value).toString();
      throw new Error(`Column ${path}: expected bigint, got ${typeof value}`);
    }
    case "date": {
      const d = toDate(value);
      if (Number.isNaN(d.getTime())) throw new Error(`Column ${path}: invalid date ${String(value)}`);
      if (col.chType === "Date") return d.toISOString().slice(0, 10);
      if (col.chType.startsWith("DateTime64")) return formatDateTime64(d);
      return Math.floor(d.getTime() / 1000);
    }
    case "enum":
      return String(value);
    case "json":
      if (typeof value === "string") return value;
      return JSON.stringify(value, bigintReplacer);
    case "array":
      return (value as unknown[]).map((v) => serializeValue(col.items!, v, path + "[]"));
  }
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number" && value < 1e12) return new Date(value * 1000);
  return new Date(value as string | number);
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
      return Number(v);
    case "bool":
      if (typeof v === "string") return v === "true" || v === "1";
      return Boolean(v);
    case "date": {
      if (typeof v === "number") return new Date(v * 1000);
      const s = String(v);
      // 'iso' output: 2024-01-01T00:00:00Z or 2024-01-01 (Date); 'simple': 2024-01-01 00:00:00
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + "T00:00:00Z");
      if (s.includes("T")) return new Date(s);
      return new Date(s.replace(" ", "T") + "Z");
    }
    case "json":
      if (typeof v === "string") return JSON.parse(v);
      return v;
    case "array":
      return (v as unknown[]).map((x) => deserializeValue(col.items!, x));
    default:
      return v;
  }
}
