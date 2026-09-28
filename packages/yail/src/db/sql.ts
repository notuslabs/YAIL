import { isTable, type Table } from "../schema/table.js";

export type SqlValue = string | number | bigint | boolean | Date | null | undefined | SqlValue[];

export interface SqlFragment {
  readonly __brand: "yail.sql";
  readonly strings: ReadonlyArray<string>;
  readonly values: ReadonlyArray<SqlValue | SqlFragment | Table<any> | SqlRaw>;
}

export interface SqlRaw {
  readonly __brand: "yail.sqlRaw";
  readonly text: string;
}

export function isSqlFragment(v: unknown): v is SqlFragment {
  return typeof v === "object" && v !== null && (v as SqlFragment).__brand === "yail.sql";
}
function isRaw(v: unknown): v is SqlRaw {
  return typeof v === "object" && v !== null && (v as SqlRaw).__brand === "yail.sqlRaw";
}

/**
 * Tagged template for parameterized ClickHouse SQL.
 *
 * Interpolated tables render as identifiers, nested fragments are inlined,
 * everything else becomes a typed `{pN:Type}` query parameter.
 *
 * @example
 * sql`SELECT * FROM ${ledger} WHERE wallet = ${wallet} AND block_number > ${100n}`
 */
export function sql(strings: TemplateStringsArray, ...values: SqlFragment["values"][number][]): SqlFragment {
  return { __brand: "yail.sql", strings: [...strings], values };
}

/** Insert raw SQL text without parameterization. Use only for trusted, static text. */
sql.raw = (text: string): SqlRaw => ({ __brand: "yail.sqlRaw", text });

/** Quote an identifier (column/table name). */
sql.identifier = (name: string): SqlRaw => ({ __brand: "yail.sqlRaw", text: `\`${name.replace(/`/g, "``")}\`` });

/** Join fragments with a separator (default `, `). */
sql.join = (fragments: ReadonlyArray<SqlFragment | SqlRaw>, separator = ", "): SqlFragment => {
  const strings: string[] = [""];
  const values: SqlFragment["values"][number][] = [];
  fragments.forEach((f, i) => {
    if (i > 0) strings[strings.length - 1] += separator;
    values.push(f);
    strings.push("");
  });
  return { __brand: "yail.sql", strings, values };
};

sql.empty = (): SqlFragment => ({ __brand: "yail.sql", strings: [""], values: [] });

export interface RenderedSql {
  text: string;
  params: Record<string, unknown>;
}

export interface RenderOptions {
  /** Inline literals instead of `{pN:Type}` placeholders (needed for DDL such as materialized views). */
  inline?: boolean;
  /** Optional database to qualify table identifiers with. */
  database?: string;
}

export function renderSql(input: SqlFragment | string, options: RenderOptions = {}): RenderedSql {
  if (typeof input === "string") return { text: input, params: {} };
  const params: Record<string, unknown> = {};
  let counter = 0;
  const next = () => `p${counter++}`;

  const render = (frag: SqlFragment): string => {
    let out = "";
    frag.strings.forEach((s, i) => {
      out += s;
      if (i < frag.values.length) out += renderValue(frag.values[i]);
    });
    return out;
  };

  const renderValue = (v: SqlFragment["values"][number]): string => {
    if (isSqlFragment(v)) return render(v);
    if (isRaw(v)) return v.text;
    if (isTable(v)) return options.database ? `\`${options.database}\`.\`${v.name}\`` : `\`${v.name}\``;
    if (options.inline) return literal(v as SqlValue);
    const name = next();
    const { type, value } = paramType(v as SqlValue);
    params[name] = value;
    return `{${name}:${type}}`;
  };

  return { text: render(input), params };
}

function paramType(v: SqlValue): { type: string; value: unknown } {
  if (v === null || v === undefined) return { type: "Nullable(String)", value: null };
  if (typeof v === "string") return { type: "String", value: v };
  if (typeof v === "boolean") return { type: "Bool", value: v };
  if (typeof v === "bigint") return { type: "Int256", value: v.toString() };
  if (typeof v === "number") return Number.isInteger(v) ? { type: "Int64", value: v } : { type: "Float64", value: v };
  if (v instanceof Date) return { type: "DateTime64(3)", value: formatDateTime64(v) };
  if (Array.isArray(v)) {
    const first = v.find((x) => x !== null && x !== undefined);
    const inner = first === undefined ? "String" : paramType(first as SqlValue).type;
    return { type: `Array(${inner})`, value: v.map((x) => paramType(x as SqlValue).value) };
  }
  throw new Error(`Unsupported SQL parameter: ${String(v)}`);
}

export function literal(v: SqlValue): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "string") return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (v instanceof Date) return `'${formatDateTime64(v)}'`;
  if (Array.isArray(v)) return `[${v.map((x) => literal(x as SqlValue)).join(", ")}]`;
  throw new Error(`Unsupported SQL literal: ${String(v)}`);
}

export function formatDateTime64(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}
