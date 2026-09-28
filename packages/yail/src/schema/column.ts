/**
 * Column builders for the YAIL schema DSL.
 *
 * Each builder carries two things: the ClickHouse type it maps to, and a
 * phantom TypeScript type used to infer row types (`InferRow<typeof table>`).
 * Serialization to/from ClickHouse's JSONEachRow format is driven by `kind`.
 */

export type ColumnKind =
  | "string"
  | "address" // lowercase 0x hex string (EVM) or base58/bech32 (BTC); stored as String
  | "hash" // 0x-prefixed hex, stored as String
  | "bool"
  | "int" // JS number, ClickHouse Int8..Int32 / UInt8..UInt32 / Float
  | "bigint" // JS bigint, ClickHouse (U)Int64..(U)Int256 / Decimal
  | "float"
  | "date" // JS Date, ClickHouse Date / DateTime / DateTime64
  | "enum"
  | "json" // any JSON, stored as String
  | "array";

export interface Column<T = unknown, Nullable extends boolean = boolean, HasDefault extends boolean = boolean> {
  readonly __type?: T;
  readonly kind: ColumnKind;
  readonly chType: string;
  readonly isNullable: Nullable;
  readonly hasDefault: HasDefault;
  readonly defaultSql?: string;
  readonly codecSql?: string;
  readonly isLowCardinality: boolean;
  readonly items?: Column;
}

type Builder<T, N extends boolean, D extends boolean> = Column<T, N, D> & {
  nullable(): Builder<T, true, D>;
  /** Column default (raw ClickHouse expression). Rows may omit the column on insert. */
  default(sql: string): Builder<T, N, true>;
  codec(codec: string): Builder<T, N, D>;
  lowCardinality(): Builder<T, N, D>;
};

function make<T>(kind: ColumnKind, chType: string, extra: Partial<Column<T, boolean, boolean>> = {}): Builder<T, false, false> {
  const col: Column<T, boolean, boolean> = {
    kind,
    chType,
    isNullable: false,
    hasDefault: false,
    isLowCardinality: false,
    ...extra,
  };
  return withMethods(col) as Builder<T, false, false>;
}

function withMethods<T, N extends boolean, D extends boolean>(col: Column<T, N, D>): Builder<T, N, D> {
  return {
    ...col,
    nullable() {
      return withMethods({ ...col, isNullable: true as const }) as Builder<T, true, D>;
    },
    default(sql: string) {
      return withMethods({ ...col, hasDefault: true as const, defaultSql: sql }) as Builder<T, N, true>;
    },
    codec(codec: string) {
      return withMethods({ ...col, codecSql: codec });
    },
    lowCardinality() {
      return withMethods({ ...col, isLowCardinality: true });
    },
  };
}

export const t = {
  string: () => make<string>("string", "String"),
  /** Lowercased hex address (EVM) or plain address string (Bitcoin). */
  address: () => make<string>("address", "String"),
  /** 0x-prefixed hex hash. */
  hash: () => make<string>("hash", "String"),
  bool: () => make<boolean>("bool", "Bool"),
  uint8: () => make<number>("int", "UInt8"),
  uint16: () => make<number>("int", "UInt16"),
  uint32: () => make<number>("int", "UInt32"),
  int8: () => make<number>("int", "Int8"),
  int16: () => make<number>("int", "Int16"),
  int32: () => make<number>("int", "Int32"),
  uint64: () => make<bigint>("bigint", "UInt64"),
  int64: () => make<bigint>("bigint", "Int64"),
  uint128: () => make<bigint>("bigint", "UInt128"),
  int128: () => make<bigint>("bigint", "Int128"),
  uint256: () => make<bigint>("bigint", "UInt256"),
  int256: () => make<bigint>("bigint", "Int256"),
  /** Alias for int256: the safe default for any EVM amount, signed so deltas fit. */
  bigint: () => make<bigint>("bigint", "Int256"),
  float32: () => make<number>("float", "Float32"),
  float64: () => make<number>("float", "Float64"),
  /** Decimal with given precision/scale, exposed as string to avoid float loss. */
  decimal: (precision: number, scale: number) => make<string>("string", `Decimal(${precision}, ${scale})`),
  date: () => make<Date>("date", "Date"),
  dateTime: () => make<Date>("date", "DateTime"),
  dateTime64: (precision = 3) => make<Date>("date", `DateTime64(${precision})`),
  enum: <const V extends readonly string[]>(values: V) =>
    make<V[number]>("enum", `Enum8(${values.map((v, i) => `'${v}' = ${i + 1}`).join(", ")})`),
  json: <T = unknown>() => make<T>("json", "String"),
  array: <C extends Column<any, boolean, boolean>>(items: C) =>
    make<Array<NonNullable<C["__type"]>>>("array", `Array(${columnTypeSql(items)})`, { items }),
} as const;

export function columnTypeSql(col: Column): string {
  let type = col.chType;
  if (col.isLowCardinality) type = `LowCardinality(${type})`;
  if (col.isNullable) type = `Nullable(${type})`;
  return type;
}
