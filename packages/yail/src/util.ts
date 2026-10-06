/** Wrap a single value in an array; copy an array. */
export function toArray<T>(value: T | readonly T[]): T[] {
  if (Array.isArray(value)) return [...(value as readonly T[])];
  return [value as T];
}

/** Split a list into consecutive slices of at most `size` items. */
export function chunkList<T>(list: T[], size: number): T[][] {
  if (list.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** JSON.stringify replacer that turns bigints into decimal strings. */
export function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}

/** Lowercase a hex string, or null when absent. */
export function lowerOrNull(value: string | null | undefined): string | null {
  if (value) return value.toLowerCase();
  return null;
}

/** URL-decode a credential from a URL, or fall back when the URL has none. */
export function decodeOr(value: string, fallback: string): string {
  if (value) return decodeURIComponent(value);
  return fallback;
}

/** Hex is case-insensitive and kept lowercase; base58 addresses (Solana, legacy Bitcoin) are not, and keep their case. */
export function normalizeHex(value: string): string {
  if (value.startsWith("0x")) return value.toLowerCase();
  return value;
}

/** `fn` over `items`, at most `limit` at a time, results in input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });
}

/** An HTTP response body, retried with backoff on 429, 5xx and network errors. Other statuses throw at once. */
export async function request(doFetch: typeof fetch, url: string, init: RequestInit = {}): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await doFetch(url, init);
      if (res.ok) return await res.text();
      const body = await res.text().catch(() => "");
      if (res.status !== 429 && res.status < 500) throw new HttpError(`${url}: HTTP ${res.status} ${body.slice(0, 300)}`);
      if (attempt === 12) throw new Error(`${url}: HTTP ${res.status} after ${attempt} attempts`);
    } catch (err) {
      if (err instanceof HttpError || init.signal?.aborted || attempt === 12) throw err;
    }
    await sleep(Math.min(30_000, 250 * 2 ** attempt), init.signal ?? undefined);
  }
}

class HttpError extends Error {}
