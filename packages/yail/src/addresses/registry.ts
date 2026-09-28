import type { Db } from "../db/client.js";
import { addresses as addressesTable } from "../db/internal.js";
import { sql } from "../db/sql.js";
import type { InferRow } from "../schema/table.js";
import { toArray } from "../util.js";

export type AddressStatus = "pending" | "backfilling" | "live" | "failed";
export type AddressRow = InferRow<typeof addressesTable>;

export interface RegisterInput {
  set: string;
  chain: string;
  address: string;
  /** First block to index this address from. Defaults to the earliest startBlock using the set on that chain. */
  fromBlock?: number;
  meta?: Record<string, unknown>;
  /** Internal: mark as live immediately (factory children, seeds at genesis). */
  status?: AddressStatus;
  adoptedAtBlock?: number;
}

function key(set: string, chain: string, address: string): string {
  return `${set}\u0001${chain}\u0001${address}`;
}

/**
 * In-memory view of `_yail_addresses`, persisted on every change.
 * Single-writer: the indexer process owns it.
 */
export class AddressRegistry {
  private rows = new Map<string, AddressRow>();
  private listeners = new Set<(row: AddressRow) => void>();

  constructor(private readonly db: Db, private readonly normalize: (chain: string, address: string) => string) {}

  /**
   * Load rows from the database, merging into memory. A row from the database
   * only replaces the in-memory one when it is newer, so a refresh racing with
   * a write made by another chain loop never reverts that write.
   */
  async load(): Promise<void> {
    const rows = await this.db.rows(addressesTable);
    for (const r of rows) {
      const k = key(r.set, r.chain, r.address);
      const existing = this.rows.get(k);
      if (existing && existing.updatedAt.getTime() > r.updatedAt.getTime()) continue;
      this.rows.set(k, r);
    }
  }

  onChange(fn: (row: AddressRow) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get(set: string, chain: string, address: string): AddressRow | undefined {
    return this.rows.get(key(set, chain, this.normalize(chain, address)));
  }

  has(set: string, chain: string, address: string): boolean {
    const r = this.get(set, chain, address);
    return r !== undefined && r.status !== "failed";
  }

  /** Addresses the live loop should include for a set on a chain (everything adopted). */
  live(set: string, chain: string): string[] {
    const out: string[] = [];
    for (const r of this.rows.values()) {
      if (r.set === set && r.chain === chain && r.status !== "failed" && r.adopted) out.push(r.address);
    }
    return out.sort(); // deterministic order: query shapes (and cache keys) must not depend on load order
  }

  list(filter: { set?: string; chain?: string; status?: AddressStatus } = {}): AddressRow[] {
    return [...this.rows.values()].filter(
      (r) => (!filter.set || r.set === filter.set) && (!filter.chain || r.chain === filter.chain) && (!filter.status || r.status === filter.status),
    );
  }

  /** Newly registered addresses on a chain not yet adopted by the live loop. */
  unadopted(chain: string): AddressRow[] {
    return [...this.rows.values()].filter((r) => r.chain === chain && !r.adopted && r.status === "pending");
  }

  async register(input: RegisterInput | RegisterInput[]): Promise<AddressRow[]> {
    const inputs = toArray(input);
    const now = new Date();
    const out: AddressRow[] = [];
    for (const i of inputs) {
      const address = this.normalize(i.chain, i.address);
      const existing = this.rows.get(key(i.set, i.chain, address));
      if (existing && existing.status !== "failed") {
        out.push(existing);
        continue;
      }
      const row: AddressRow = {
        set: i.set,
        chain: i.chain,
        address,
        status: i.status ?? "pending",
        fromBlock: BigInt(i.fromBlock ?? 0),
        adopted: i.adoptedAtBlock !== undefined,
        adoptedAtBlock: BigInt(i.adoptedAtBlock ?? 0),
        meta: i.meta ?? {},
        error: "",
        registeredAt: existing?.registeredAt ?? now,
        updatedAt: now,
      };
      this.rows.set(key(row.set, row.chain, row.address), row);
      out.push(row);
    }
    const fresh = out.filter((r) => r.updatedAt === now);
    if (fresh.length > 0) await this.db.insert(addressesTable).values(fresh);
    for (const r of fresh) for (const l of this.listeners) l(r);
    return out;
  }

  async update(set: string, chain: string, address: string, patch: Partial<Pick<AddressRow, "status" | "adopted" | "adoptedAtBlock" | "error" | "fromBlock">>): Promise<AddressRow> {
    const k = key(set, chain, this.normalize(chain, address));
    const existing = this.rows.get(k);
    if (!existing) throw new Error(`address ${address} not registered in set ${set} on ${chain}`);
    const row: AddressRow = { ...existing, ...patch, updatedAt: new Date() };
    this.rows.set(k, row);
    await this.db.insert(addressesTable).values(row);
    for (const l of this.listeners) l(row);
    return row;
  }

  async updateMany(rows: AddressRow[], patch: Partial<Pick<AddressRow, "status" | "adopted" | "adoptedAtBlock" | "error">>): Promise<void> {
    if (rows.length === 0) return;
    const now = new Date();
    const updated = rows.map((r) => ({ ...r, ...patch, updatedAt: now }));
    for (const r of updated) this.rows.set(key(r.set, r.chain, r.address), r);
    await this.db.insert(addressesTable).values(updated);
    for (const r of updated) for (const l of this.listeners) l(r);
  }

  /** Sets that contain an address on a chain (used by scope re-index). */
  setsContaining(chain: string, address: string): AddressRow[] {
    const a = this.normalize(chain, address);
    return [...this.rows.values()].filter((r) => r.chain === chain && r.address === a);
  }

  async counts(): Promise<Array<{ set: string; chain: string; status: string; count: number }>> {
    const rows = await this.db.query<{ set: string; chain: string; status: string; count: string }>(
      sql`SELECT set, chain, status, count() AS count FROM ${addressesTable} FINAL GROUP BY set, chain, status ORDER BY set, chain, status`,
    );
    return rows.map((r) => ({ ...r, count: Number(r.count) }));
  }
}
