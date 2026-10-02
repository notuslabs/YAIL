import type { Db } from "../db/client.js";
import { effects as effectsTable } from "../db/internal.js";
import { sql } from "../db/sql.js";
import type { HttpClient } from "../http/client.js";
import type { CachedClient } from "../rpc/cached-client.js";

/** What an effect may reach: the chain it runs for, its RPC client (when the chain has `rpc`) and HTTP. */
export interface EffectContext {
  chain: { name: string; id: number | string; kind: "evm" | "bitcoin" };
  client: CachedClient | undefined;
  http: HttpClient;
}

/**
 * A named async function of a JSON input whose output is kept forever per `(chain, name, input)` in `_yail_effects`:
 * token metadata, a price, a provider lookup. Handlers call it through `context.effect(fx, input)`; the first call
 * runs it, later ones read the cache. The table is plain ClickHouse, so a view can read the outputs too.
 */
export interface Effect<I, O> {
  readonly __brand: "yail.effect";
  readonly name: string;
  readonly run: (input: I, context: EffectContext) => Promise<O>;
}

export function effect<I, O>(name: string, run: (input: I, context: EffectContext) => Promise<O>): Effect<I, O> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`Invalid effect name "${name}"`);
  return { __brand: "yail.effect", name, run };
}

/** JSON with object keys sorted, so equal inputs make equal cache keys. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : typeof v === "bigint" ? v.toString() : v));
}

/** The cache for one chain: memory in front of `_yail_effects`. */
export class EffectCache {
  private memory = new Map<string, string>();
  private inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly db: Db, private readonly context: EffectContext, private readonly onCache?: (hit: boolean) => void) {}

  async run<I, O>(fx: Effect<I, O>, input: I): Promise<O> {
    const inputJson = canonical(input);
    const key = `${fx.name}\u0001${inputJson}`;
    const chain = this.context.chain.name;
    let output = this.memory.get(key);
    if (output === undefined) {
      const rows = await this.db.query<{ output: string }>(sql`SELECT output FROM ${effectsTable} FINAL WHERE chain = ${chain} AND effect = ${fx.name} AND input = ${inputJson} LIMIT 1`);
      output = rows[0]?.output;
    }
    this.onCache?.(output !== undefined);
    if (output !== undefined) {
      this.memory.set(key, output);
      return JSON.parse(output) as O;
    }
    // Concurrent calls with the same input share one run.
    let pending = this.inflight.get(key) as Promise<O> | undefined;
    if (!pending) {
      pending = fx.run(input, this.context).then(async (result) => {
        const json = canonical(result);
        this.memory.set(key, json);
        await this.db.insert(effectsTable).values({ chain, effect: fx.name, input: inputJson, output: json, createdAt: new Date() });
        return result;
      });
      this.inflight.set(key, pending);
      pending.finally(() => this.inflight.delete(key));
    }
    return pending;
  }
}

/** Fix an effect's answer for a chain, e.g. in tests, so it never runs. */
export async function seedEffect<I, O>(db: Db, chain: string, fx: Effect<I, O>, input: I, output: O): Promise<void> {
  await db.insert(effectsTable).values({ chain, effect: fx.name, input: canonical(input), output: canonical(output), createdAt: new Date() });
}
