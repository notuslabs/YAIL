import type { HttpClient } from "../http/client.js";
import type { CachedClient } from "../rpc/cached-client.js";

/** What a lookup may reach: the chain it runs for, its RPC client (when the chain has `rpc`) and HTTP. */
export interface LookupContext {
  chain: { name: string; id: number | string; kind: "evm" | "bitcoin" };
  client: CachedClient | undefined;
  http: HttpClient;
}

/**
 * Something resolved outside the chain data, once per `(chain, name, input)`: a token's metadata over RPC, a price
 * from an API, a request through a provider. Handlers call it through `context.lookup(fx, input)`; the answer is
 * kept in the configured cache (`lookups.cache`: memory, or Redis), so re-runs and re-indexes never ask again.
 */
export interface Lookup<I, O> {
  readonly __brand: "yail.lookup";
  readonly name: string;
  readonly run: (input: I, context: LookupContext) => Promise<O>;
}

export function lookup<I, O>(name: string, run: (input: I, context: LookupContext) => Promise<O>): Lookup<I, O> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`Invalid lookup name "${name}"`);
  return { __brand: "yail.lookup", name, run };
}

/** Where lookup answers live. Keys are `${chain}:${name}:${canonical input}`; values are JSON. */
export interface LookupCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

/** JSON with object keys sorted, so equal inputs make equal keys. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : typeof v === "bigint" ? v.toString() : v));
}

export const lookupKey = (chain: string, fx: Lookup<any, any>, input: unknown) => `${chain}:${fx.name}:${canonical(input)}`;

/** Runs lookups for one chain against the cache; concurrent calls with the same input share one run. */
export class Lookups {
  private inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly cache: LookupCache, private readonly context: LookupContext, private readonly onCache?: (hit: boolean) => void) {}

  async run<I, O>(fx: Lookup<I, O>, input: I): Promise<O> {
    const key = lookupKey(this.context.chain.name, fx, input);
    const cached = await this.cache.get(key);
    this.onCache?.(cached !== undefined);
    if (cached !== undefined) return JSON.parse(cached) as O;
    let pending = this.inflight.get(key) as Promise<O> | undefined;
    if (!pending) {
      pending = fx.run(input, this.context).then(async (result) => {
        await this.cache.set(key, canonical(result));
        return result;
      });
      this.inflight.set(key, pending);
      pending.finally(() => this.inflight.delete(key));
    }
    return pending;
  }
}

/** Fix a lookup's answer, e.g. in tests, so it never runs. */
export async function seedLookup<I, O>(cache: LookupCache, chain: string, fx: Lookup<I, O>, input: I, output: O): Promise<void> {
  await cache.set(lookupKey(chain, fx, input), canonical(output));
}
