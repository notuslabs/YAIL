import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { reviveBatch, serializeBatch } from "./cached.js";
import { matchesTxFilters } from "./rpc.js";
import type { BitcoinBatch, BitcoinQuery, BitcoinSource, BitcoinTransaction, EvmBatch, EvmBlock, EvmLog, EvmQuery, EvmSource, EvmTrace, EvmTransaction, SolanaBalance, SolanaBatch, SolanaBlock, SolanaQuery, SolanaSource, SolanaTransaction, Source } from "./types.js";
import { logOrder, lower, txOrder } from "./types.js";

export interface EvmFixture {
  version: 1;
  kind: "evm";
  name?: string;
  chainId?: number;
  height: number;
  fromBlock: number;
  toBlock: number;
  blocks: EvmBlock[];
  transactions: EvmTransaction[];
  logs: EvmLog[];
  traces?: EvmTrace[];
  /** Free-form ground truth captured at record time, for assertions in tests. */
  expected?: Record<string, unknown>;
}

export interface BitcoinFixture {
  version: 1;
  kind: "bitcoin";
  name?: string;
  height: number;
  fromBlock: number;
  toBlock: number;
  transactions: BitcoinTransaction[];
  expected?: Record<string, unknown>;
}

export interface SolanaFixture {
  version: 1;
  kind: "solana";
  name?: string;
  height: number;
  /** Replayed as the source's `firstBlock()`, to stand in for a source with partial history. */
  firstBlock?: number;
  fromBlock: number;
  toBlock: number;
  blocks: SolanaBlock[];
  transactions: SolanaTransaction[];
  balances: SolanaBalance[];
  expected?: Record<string, unknown>;
}

export type Fixture = EvmFixture | BitcoinFixture | SolanaFixture;

/**
 * Replay a recorded fixture as a source. Queries are answered by filtering
 * the recorded data, so a broad recording (e.g. every log of a pool) can
 * serve narrower runtime queries (e.g. only Swap events).
 */
export function fixtureSource(fixture: EvmFixture, options?: { blocksPerBatch?: number }): EvmSource;
export function fixtureSource(fixture: BitcoinFixture, options?: { blocksPerBatch?: number }): BitcoinSource;
export function fixtureSource(fixture: SolanaFixture, options?: { blocksPerBatch?: number }): SolanaSource;
export function fixtureSource(fixture: Fixture, options: { blocksPerBatch?: number } = {}): Source {
  const per = options.blocksPerBatch ?? 1000;
  if (fixture.kind === "evm") {
    const src: EvmSource = {
      kind: "evm",
      name: `fixture(${fixture.name ?? "evm"})`,
      async getHeight() {
        return fixture.height;
      },
      async *fetch(query: EvmQuery) {
        let from = query.fromBlock;
        while (from < query.toBlock) {
          const to = Math.min(from + per, query.toBlock);
          const inRange = (x: { blockNumber: number }) => x.blockNumber >= from && x.blockNumber < to;
          const logMatches = (l: EvmLog) => matchesLogFilters(l, query);
          const traceMatches = (t: EvmTrace) => matchesTxFilters(t.from, t.to, query.traces ?? []);
          const matched = new Set([...fixture.logs.filter(logMatches), ...(fixture.traces ?? []).filter(traceMatches)].map((x) => x.transactionHash));
          const txs = fixture.transactions
            .filter(inRange)
            .filter((t) => (query.transactions.length > 0 && matchesTxFilters(t.from, t.to, query.transactions)) || ((query.includeLogTransactions || query.join) && matched.has(t.hash)))
            .sort(txOrder);
          // With `join`, every log and trace of a returned transaction comes along.
          const joined = new Set<string>();
          if (query.join) for (const t of txs) joined.add(t.hash);
          const logs = fixture.logs.filter((l) => inRange(l) && (logMatches(l) || joined.has(l.transactionHash))).sort(logOrder);
          const traces = (fixture.traces ?? []).filter((t) => inRange(t) && (traceMatches(t) || joined.has(t.transactionHash)));
          const wanted = new Set([...logs.map((l) => l.blockNumber), ...txs.map((t) => t.blockNumber)]);
          const blocks = fixture.blocks.filter((b) => wanted.has(b.number)).sort((a, b) => a.number - b.number);
          yield { fromBlock: from, nextBlock: to, blocks, transactions: txs, logs, traces, archiveHeight: fixture.height } satisfies EvmBatch;
          from = to;
        }
      },
      async getBlock(n: number) {
        return fixture.blocks.find((b) => b.number === n) ?? null;
      },
    };
    return src;
  }
  if (fixture.kind === "solana") {
    const src: SolanaSource = {
      kind: "solana",
      name: `fixture(${fixture.name ?? "solana"})`,
      async getHeight() {
        return fixture.height;
      },
      async *fetch(query: SolanaQuery) {
        if (query.fromBlock < (fixture.firstBlock ?? 0)) throw new Error(`fixture(${fixture.name}): asked for slot ${query.fromBlock}, below its first block ${fixture.firstBlock}`);
        const wallets = new Set(query.addresses);
        let from = query.fromBlock;
        while (from < query.toBlock) {
          const to = Math.min(from + per, query.toBlock);
          const balances = fixture.balances.filter((b) => b.slot >= from && b.slot < to && wallets.has(b.token ? b.token.owner : b.account));
          const signatures = new Set(balances.map((b) => b.signature));
          const transactions = fixture.transactions.filter((t) => signatures.has(t.signature));
          const blocks = fixture.blocks.filter((b) => transactions.some((t) => t.slot === b.slot));
          yield { fromBlock: from, nextBlock: to, blocks, transactions, balances } satisfies SolanaBatch;
          from = to;
        }
      },
    };
    if (fixture.firstBlock !== undefined) src.firstBlock = async () => fixture.firstBlock!;
    return src;
  }
  const btc: BitcoinSource = {
    kind: "bitcoin",
    name: `fixture(${fixture.name ?? "bitcoin"})`,
    async getHeight() {
      return fixture.height;
    },
    async *fetch(query: BitcoinQuery) {
      const set = new Set(query.addresses);
      const txs = fixture.transactions
        .filter((t) => t.blockHeight >= query.fromBlock && t.blockHeight < query.toBlock)
        .filter((t) => t.vin.some((v) => v.prevout?.address && set.has(v.prevout.address)) || t.vout.some((o) => o.address && set.has(o.address)))
        .sort((a, b) => a.blockHeight - b.blockHeight || a.txid.localeCompare(b.txid));
      yield { fromBlock: query.fromBlock, nextBlock: query.toBlock, transactions: txs } satisfies BitcoinBatch;
    },
  };
  return btc;
}

export function matchesLogFilters(log: EvmLog, query: EvmQuery): boolean {
  if (query.logs.length === 0) return false;
  return query.logs.some((f) => {
    if (f.address && f.address.length > 0 && !f.address.map(lower).includes(lower(log.address))) return false;
    if (f.topics) {
      for (let i = 0; i < f.topics.length; i++) {
        const alts = f.topics[i];
        if (alts === null || alts === undefined || alts.length === 0) continue;
        const topic = log.topics[i];
        if (!topic || !alts.map(lower).includes(lower(topic))) return false;
      }
    }
    return true;
  });
}

/** Record every batch of a query into a fixture object (EVM). */
export async function recordEvmFixture(source: EvmSource, query: EvmQuery, meta: { name?: string; chainId?: number; expected?: Record<string, unknown> } = {}): Promise<EvmFixture> {
  const fx: EvmFixture = { version: 1, kind: "evm", name: meta.name, chainId: meta.chainId, height: await source.getHeight(), fromBlock: query.fromBlock, toBlock: query.toBlock, blocks: [], transactions: [], logs: [], traces: [], expected: meta.expected };
  const blocks = new Map<number, EvmBlock>();
  const txs = new Map<string, EvmTransaction>();
  for await (const batch of source.fetch(query)) {
    for (const b of batch.blocks) blocks.set(b.number, b);
    for (const t of batch.transactions) txs.set(t.hash, t);
    fx.logs.push(...batch.logs);
    fx.traces!.push(...(batch.traces ?? []));
  }
  fx.blocks = [...blocks.values()].sort((a, b) => a.number - b.number);
  fx.transactions = [...txs.values()].sort(txOrder);
  fx.logs.sort(logOrder);
  return fx;
}

export async function recordBitcoinFixture(source: BitcoinSource, query: BitcoinQuery, meta: { name?: string; expected?: Record<string, unknown> } = {}): Promise<BitcoinFixture> {
  const fx: BitcoinFixture = { version: 1, kind: "bitcoin", name: meta.name, height: await source.getHeight(), fromBlock: query.fromBlock, toBlock: query.toBlock, transactions: [], expected: meta.expected };
  for await (const batch of source.fetch(query)) fx.transactions.push(...batch.transactions);
  return fx;
}

export async function recordSolanaFixture(source: SolanaSource, query: SolanaQuery, meta: { name?: string; expected?: Record<string, unknown> } = {}): Promise<SolanaFixture> {
  const fx: SolanaFixture = { version: 1, kind: "solana", name: meta.name, height: await source.getHeight(), fromBlock: query.fromBlock, toBlock: query.toBlock, blocks: [], transactions: [], balances: [], expected: meta.expected };
  for await (const batch of source.fetch(query)) {
    fx.blocks.push(...batch.blocks);
    fx.transactions.push(...batch.transactions);
    fx.balances.push(...batch.balances);
  }
  return fx;
}

export function writeFixture(path: string, fixture: Fixture): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeBatch(fixture) + "\n");
}

export function readFixture<T extends Fixture = Fixture>(path: string): T {
  return reviveBatch(readFileSync(path, "utf8")) as T;
}
