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

export interface Column<T = unknown, Nullable extends boolean = false> {
  readonly __type?: T;
  readonly kind: ColumnKind;
  readonly chType: string;
  readonly isNullable: Nullable;
  readonly hasDefault: boolean;
  readonly defaultSql?: string;
  readonly codecSql?: string;
  readonly isLowCardinality: boolean;
  readonly items?: Column;
}

type Builder<T, N extends boolean> = Column<T, N> & {
  nullable(): Builder<T, true>;
  default(sql: string): Builder<T, N>;
  codec(codec: string): Builder<T, N>;
  lowCardinality(): Builder<T, N>;
};

function make<T>(kind: ColumnKind, chType: string, extra: Partial<Column<T>> = {}): Builder<T, false> {
  const col: Column<T, boolean> = {
    kind,
    chType,
    isNullable: false,
    hasDefault: false,
    isLowCardinality: false,
    ...extra,
  };
  return withMethods(col) as Builder<T, false>;
}

function withMethods<T, N extends boolean>(col: Column<T, N>): Builder<T, N> {
  return {
    ...col,
    nullable() {
      return withMethods({ ...col, isNullable: true as const }) as Builder<T, true>;
    },
    default(sql: string) {
      return withMethods({ ...col, hasDefault: true, defaultSql: sql });
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
  array: <C extends Column>(items: C) =>
    make<Array<NonNullable<C["__type"]>>>("array", `Array(${columnTypeSql(items)})`, { items }),
} as const;

export function columnTypeSql(col: Column): string {
  let type = col.chType;
  if (col.isLowCardinality) type = `LowCardinality(${type})`;
  if (col.isNullable) type = `Nullable(${type})`;
  return type;
}
