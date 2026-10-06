/** Where cached answers live. Keys are `${chain}:${key}`; values are JSON. */
export interface CacheStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

/** A cache key: a string, or a tuple such as `["tokenMetadata", address]`. */
export type CacheKey = string | readonly unknown[];

/** What `context.cache` takes, after useQuery: the key the answer is kept under, and the handler that computes it. */
export interface CacheQuery<O> {
  key: CacheKey;
  handler: () => Promise<O>;
}

/** JSON with object keys sorted, so equal values make equal keys. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : typeof v === "bigint" ? v.toString() : v));
}

export const cacheKey = (chain: string, key: CacheKey) => `${chain}:${typeof key === "string" ? key : canonical(key)}`;

/**
 * `context.cache({ key, handler })` for one chain: the answer for `key` is computed once by `handler` and kept in the store, so
 * re-runs and re-indexes never compute it again; concurrent calls with the same key share one run.
 */
export class CacheRunner {
  private inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly store: CacheStore, private readonly chain: string, private readonly onCache?: (hit: boolean) => void) {}

  async run<O>({ key, handler }: CacheQuery<O>): Promise<O> {
    const full = cacheKey(this.chain, key);
    const cached = await this.store.get(full);
    this.onCache?.(cached !== undefined);
    if (cached !== undefined) return JSON.parse(cached) as O;
    let pending = this.inflight.get(full) as Promise<O> | undefined;
    if (!pending) {
      pending = Promise.resolve()
        .then(handler)
        .then(async (result) => {
          await this.store.set(full, canonical(result));
          return result;
        })
        .finally(() => this.inflight.delete(full));
      this.inflight.set(full, pending);
    }
    return pending;
  }
}

/** Fix a cached answer, e.g. in tests, so its function never runs. */
export async function seedCache(store: CacheStore, chain: string, key: CacheKey, output: unknown): Promise<void> {
  await store.set(cacheKey(chain, key), canonical(output));
}
