import type { LookupCache } from "./lookup.js";

/** The default: answers live for the process. */
export function memory(): LookupCache {
  const map = new Map<string, string>();
  return { get: async (key) => map.get(key), set: async (key, value) => void map.set(key, value) };
}

/** Answers in Redis, under `prefix` (default `yail:lookup:`), forever. Needs the optional peer dependency `redis`. */
export function redis(options: { url: string; prefix?: string }): LookupCache {
  const prefix = options.prefix ?? "yail:lookup:";
  let client: Promise<{ get(key: string): Promise<string | null>; set(key: string, value: string): Promise<unknown> }> | undefined;
  const connect = () =>
    (client ??= import("redis")
      .catch(() => {
        throw new Error("redis(): install the optional peer dependency `redis`.");
      })
      .then(({ createClient }) => createClient({ url: options.url }).connect()));
  return {
    get: async (key) => (await (await connect()).get(prefix + key)) ?? undefined,
    set: async (key, value) => void (await (await connect()).set(prefix + key, value)),
  };
}
