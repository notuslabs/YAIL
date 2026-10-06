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
