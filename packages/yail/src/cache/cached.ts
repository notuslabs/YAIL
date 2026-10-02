import type { HttpClient } from "../http/client.js";
import type { CachedClient } from "../rpc/cached-client.js";

/** What a cached function may reach: the chain it runs for, its RPC client (when the chain has `rpc`) and HTTP. */
export interface CacheContext {
  chain: { name: string; id: number | string; kind: "evm" | "bitcoin" };
  client: CachedClient | undefined;
  http: HttpClient;
}

/**
 * A cached function: something resolved outside the chain data, once per `(chain, name, input)`: a token's metadata
 * over RPC, a price from an API, a request through a provider. Handlers call it through `context.cache(fx, input)`;
 * the answer is kept in the configured store (`cache.store`: memory, or Redis), so re-runs and re-indexes never ask again.
 */
export interface Cached<I, O> {
  readonly __brand: "yail.cached";
  readonly name: string;
  readonly run: (input: I, context: CacheContext) => Promise<O>;
}

export function cache<I, O>(name: string, run: (input: I, context: CacheContext) => Promise<O>): Cached<I, O> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`Invalid cached function name "${name}"`);
  return { __brand: "yail.cached", name, run };
}

/** Where cached answers live. Keys are `${chain}:${name}:${canonical input}`; values are JSON. */
export interface CacheStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

/** JSON with object keys sorted, so equal inputs make equal keys. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : typeof v === "bigint" ? v.toString() : v));
}

export const cacheKey = (chain: string, fx: Cached<any, any>, input: unknown) => `${chain}:${fx.name}:${canonical(input)}`;

/** Runs cached functions for one chain against the store; concurrent calls with the same input share one run. */
export class CacheRunner {
  private inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly cache: CacheStore, private readonly context: CacheContext, private readonly onCache?: (hit: boolean) => void) {}

  async run<I, O>(fx: Cached<I, O>, input: I): Promise<O> {
    const key = cacheKey(this.context.chain.name, fx, input);
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

/** Fix a cached function's answer, e.g. in tests, so it never runs. */
export async function seedCache<I, O>(cache: CacheStore, chain: string, fx: Cached<I, O>, input: I, output: O): Promise<void> {
  await cache.set(cacheKey(chain, fx, input), canonical(output));
}
