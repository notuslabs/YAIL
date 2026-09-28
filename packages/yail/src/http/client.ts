import { createHash } from "node:crypto";
import type { Db } from "../db/client.js";
import { httpCache } from "../db/internal.js";
import { sql } from "../db/sql.js";

export interface HttpCacheOptions {
  /** Cache the response. `true` caches forever (right for historical lookups); a number is a TTL in ms. */
  cache?: boolean | number;
  /** Extra string mixed into the cache key (e.g. a schema version) to invalidate old entries. */
  cacheKey?: string;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
  cached: boolean;
  json<T = unknown>(): T;
}

/** `fetch` init without the browser `cache` mode, plus YAIL's cache options. */
export type HttpRequestInit = Omit<RequestInit, "cache"> & HttpCacheOptions;

export interface HttpClient {
  get(url: string, init?: HttpRequestInit): Promise<HttpResponse>;
  post(url: string, body: unknown, init?: HttpRequestInit): Promise<HttpResponse>;
  fetch(url: string, init?: HttpRequestInit): Promise<HttpResponse>;
}

export interface HttpClientOptions {
  db?: Db;
  /** Persist to ClickHouse (`_yail_http_cache`). When false, only the in-memory LRU is used. */
  persist?: boolean;
  /** In-memory entries. Default 5000. */
  memorySize?: number;
  fetch?: typeof fetch;
  onCache?: (hit: boolean) => void;
  /** Retries on 429/5xx/network errors. Default 3. */
  retries?: number;
}

/**
 * HTTP client with an optional response cache. Cached calls are deterministic
 * across re-indexes, which is what you want for price lookups, swap
 * classification via aggregator APIs, token metadata, etc.
 */
export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const doFetch = options.fetch ?? fetch;
  const memory = new Map<string, { res: HttpResponse; expiresAt: number }>();
  const memorySize = options.memorySize ?? 5000;
  const persist = options.persist !== false && options.db !== undefined;
  const retries = options.retries ?? 3;

  const remember = (key: string, res: HttpResponse, expiresAt: number) => {
    if (memory.size >= memorySize) memory.delete(memory.keys().next().value!);
    memory.set(key, { res, expiresAt });
  };

  async function run(url: string, init: HttpRequestInit = {}): Promise<HttpResponse> {
    const { cache, cacheKey, ...reqInit } = init;
    let ttl = 0;
    if (cache === true) ttl = Infinity;
    else if (typeof cache === "number") ttl = cache;
    let key: string | undefined;
    if (ttl > 0) key = hashRequest(url, reqInit, cacheKey);
    const now = Date.now();
    if (key) {
      const m = memory.get(key);
      if (m && m.expiresAt > now) {
        options.onCache?.(true);
        return { ...m.res, cached: true };
      }
      if (persist) {
        const rows = await options.db!.rows(httpCache, sql`WHERE key = ${key} LIMIT 1`);
        const row = rows[0];
        if (row && row.expiresAt.getTime() > now) {
          const res = toResponse(row.status, JSON.parse(row.headers), row.body, true);
          remember(key, res, row.expiresAt.getTime());
          options.onCache?.(true);
          return res;
        }
      }
      options.onCache?.(false);
    }
    const res = await fetchWithRetry(url, reqInit);
    if (key && res.ok) {
      let expiresAt = now + ttl;
      if (ttl === Infinity) expiresAt = new Date("2200-01-01T00:00:00Z").getTime();
      remember(key, res, expiresAt);
      if (persist) {
        await options.db!.insert(httpCache).values({
          key,
          url,
          status: res.status,
          headers: JSON.stringify(res.headers),
          body: res.body,
          fetchedAt: new Date(now),
          expiresAt: new Date(expiresAt),
        });
      }
    }
    return res;
  }

  async function fetchWithRetry(url: string, init: RequestInit): Promise<HttpResponse> {
    let attempt = 0;
    for (;;) {
      try {
        const r = await doFetch(url, init);
        if ((r.status === 429 || r.status >= 500) && attempt < retries) {
          attempt++;
          await new Promise((res) => setTimeout(res, 300 * 2 ** attempt));
          continue;
        }
        const headers: Record<string, string> = {};
        r.headers.forEach((v, k) => (headers[k] = v));
        return toResponse(r.status, headers, await r.text(), false);
      } catch (err) {
        if (attempt >= retries) throw err;
        attempt++;
        await new Promise((res) => setTimeout(res, 300 * 2 ** attempt));
      }
    }
  }

  return {
    fetch: run,
    get: (url, init) => run(url, { ...init, method: "GET" }),
    post: (url, body, init) =>
      run(url, {
        ...init,
        method: "POST",
        headers: { "content-type": "application/json", ...(init?.headers as Record<string, string> | undefined) },
        body: toBody(body),
      }),
  };
}

function toBody(body: unknown): string {
  if (typeof body === "string") return body;
  return JSON.stringify(body);
}

function toResponse(status: number, headers: Record<string, string>, body: string, cached: boolean): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    body,
    cached,
    json<T>() {
      return JSON.parse(body) as T;
    },
  };
}

function hashRequest(url: string, init: RequestInit, extra?: string): string {
  const h = createHash("sha256");
  h.update(init.method ?? "GET").update("\n").update(url).update("\n");
  if (init.body) h.update(toBody(init.body));
  if (extra) h.update("\n").update(extra);
  return h.digest("hex").slice(0, 40);
}
