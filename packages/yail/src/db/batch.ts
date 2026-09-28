import type { InferRow, InsertRow, Table } from "../schema/table.js";
import type { Db } from "./client.js";
import { serializeRow, type RowMeta } from "./serialize.js";

interface Pending {
  table: Table<any>;
  rows: Record<string, unknown>[]; // serialized
  /** ORDER BY key -> latest logical row (for buffer-aware `find`). */
  byKey: Map<string, Record<string, unknown>>;
}

/**
 * Buffers rows per table and flushes them in one INSERT per table.
 * ClickHouse wants few, large inserts; handlers want to write row-by-row.
 * The indexer flushes after every source batch, before writing the checkpoint.
 */
export class BatchWriter {
  private pending = new Map<string, Pending>();
  private rowCount = 0;

  constructor(
    private readonly db: Db,
    private readonly options: { maxRows?: number; onFlush?: (stats: { table: string; rows: number; ms: number }) => void } = {},
  ) {}

  get size(): number {
    return this.rowCount;
  }

  add<T extends Table<any>>(table: T, row: InsertRow<T>, meta?: RowMeta): void {
    let p = this.pending.get(table.name);
    if (!p) {
      p = { table, rows: [], byKey: new Map() };
      this.pending.set(table.name, p);
    }
    p.rows.push(serializeRow(table, row as Record<string, unknown>, meta));
    p.byKey.set(keyOf(table, row as Record<string, unknown>), row as Record<string, unknown>);
    this.rowCount++;
  }

  /** Latest buffered logical row matching the full ORDER BY key, if any. */
  peek<T extends Table<any>>(table: T, key: Partial<InferRow<T>>): InferRow<T> | null {
    const p = this.pending.get(table.name);
    if (!p) return null;
    const complete = table.options.orderBy.every((k) => (key as any)[k] !== undefined);
    if (!complete) return null;
    return (p.byKey.get(keyOf(table, key as Record<string, unknown>)) as InferRow<T>) ?? null;
  }

  async flush(): Promise<{ tables: number; rows: number }> {
    const entries = [...this.pending.values()];
    this.pending = new Map();
    const rows = this.rowCount;
    this.rowCount = 0;
    for (const p of entries) {
      const start = performance.now();
      await this.db.insertRaw(p.table.name, p.rows);
      this.options.onFlush?.({ table: p.table.name, rows: p.rows.length, ms: performance.now() - start });
    }
    return { tables: entries.length, rows };
  }

  shouldFlush(): boolean {
    return this.options.maxRows !== undefined && this.rowCount >= this.options.maxRows;
  }

  discard(): void {
    this.pending = new Map();
    this.rowCount = 0;
  }
}

function keyOf(table: Table<any>, row: Record<string, unknown>): string {
  return table.options.orderBy
    .map((k) => {
      const v = row[k];
      if (typeof v === "string" && v.startsWith("0x")) return v.toLowerCase();
      if (v instanceof Date) return String(v.getTime());
      return String(v);
    })
    .join("\u0001");
}
