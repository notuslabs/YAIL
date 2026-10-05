import type { EvmBlock, EvmSource, FetchOptions, RangeBatch, RangeQuery, Source } from "./types.js";

/** History floors move (Solana HyperSync keeps backfilling), so they are read again this often. */
const FLOOR_TTL_MS = 60 * 60 * 1000;

/**
 * Several sources of one chain as one. Each block range goes to the first source, in the given order, that holds
 * it, so the usual shape is the fast source first and a complete one after it:
 *
 *   union(hypersyncSolana(), solanaRpc({ url }))   // recent slots from HyperSync, older ones over RPC
 *
 * Where a source's data starts comes from its `firstBlock()`. A source is never asked for a range below it.
 * The head (`getHeight`) is the first source's.
 */
export function union<S extends Source>(...sources: [S, ...S[]]): S {
  const kind = sources[0].kind;
  const mixed = sources.find((s) => s.kind !== kind);
  if (mixed) throw new Error(`union(): ${mixed.name} is a ${mixed.kind} source, ${sources[0].name} is ${kind}`);
  const floors = sources.map((source) => ({ source, value: 0, at: -Infinity }));

  async function firstBlocks(): Promise<number[]> {
    const now = Date.now();
    return Promise.all(
      floors.map(async (f) => {
        if (!f.source.firstBlock || now - f.at < FLOOR_TTL_MS) return f.value;
        f.value = await f.source.firstBlock();
        f.at = now;
        return f.value;
      }),
    );
  }

  /** The source that serves `block` and where its turn ends: the next block a source before it starts at. */
  function route(starts: number[], block: number, toBlock: number): { source: S; end: number } {
    const i = starts.findIndex((start) => start <= block);
    if (i === -1) throw new Error(`union(): no source holds block ${block} (sources start at ${starts.join(", ")})`);
    // Every source before `i` starts above `block`; the earliest of them takes over there.
    return { source: sources[i]!, end: Math.min(toBlock, ...starts.slice(0, i)) };
  }

  const wrapped: Record<string, unknown> = {
    kind,
    name: `union(${sources.map((s) => s.name).join(", ")})`,
    getHeight: () => sources[0].getHeight(),
    async firstBlock() {
      return Math.min(...(await firstBlocks()));
    },
    async *fetch(query: RangeQuery, options?: FetchOptions): AsyncIterable<RangeBatch> {
      const starts = await firstBlocks();
      let from = query.fromBlock;
      while (from < query.toBlock) {
        const { source, end } = route(starts, from, query.toBlock);
        yield* (source as EvmSource).fetch({ ...(query as any), fromBlock: from, toBlock: end }, options) as AsyncIterable<RangeBatch>;
        from = end;
      }
    },
  };
  if (kind === "evm") {
    wrapped.getBlock = async (number: number): Promise<EvmBlock | null> => {
      const { source } = route(await firstBlocks(), number, number + 1);
      return (source as EvmSource).getBlock?.(number) ?? null;
    };
  }
  return wrapped as unknown as S;
}
