/** Chain names referenced by a `chain` field: a single name or a per-chain override map. */
export function chainNames(ref: string | Readonly<Record<string, unknown>>): string[] {
  if (typeof ref === "string") return [ref];
  return Object.keys(ref);
}

/** Per-chain overrides for a `chain` field; a single name maps to an empty override. */
export function perChain<T>(ref: string | Readonly<Record<string, T>>): Record<string, Partial<T>> {
  if (typeof ref === "string") return { [ref]: {} };
  return { ...ref };
}
