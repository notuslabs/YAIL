import type { EvmBatch, EvmLog, EvmLogFilter, EvmQuery, EvmTxFilter } from "./types.js";
import { lower } from "./types.js";

/**
 * The query that returns every block of `query`'s range whole: every log, transaction and trace `query` could
 * select. Answered by `matchEvmBatch(batch, query)`, it gives what `query` itself returns, without sending a filter
 * per address: what a HyperSync query costs near the head grows with the blocks, not with the addresses.
 */
export function wholeBlocksQuery(query: EvmQuery): EvmQuery {
  const all = (wanted: boolean) => (wanted ? [{}] : []);
  return {
    fromBlock: query.fromBlock,
    toBlock: query.toBlock,
    logs: all(query.logs.length > 0 || query.join === true),
    transactions: all(query.transactions.length > 0 || query.join === true || query.includeLogTransactions === true),
    traces: all((query.traces?.length ?? 0) > 0 || query.join === true),
  };
}

/**
 * What `query` selects from a batch, the way the HyperSync source answers it: matched logs, transactions and traces;
 * the transactions of matched logs with `includeLogTransactions`; with `join`, every transaction matched by a
 * transaction filter, a trace filter or a `join` log filter whole, with all of its logs and traces. Every item comes
 * out once, in the batch's order, with the blocks they are in.
 */
export function matchEvmBatch(batch: EvmBatch, query: EvmQuery): EvmBatch {
  return evmMatcher(query)(batch);
}

/**
 * `matchEvmBatch` with the query's address Sets built once: with tens of thousands of wallets they cost more than
 * matching a block, so a matcher is reused across batches and polls while the query is the same. Its Sets are exposed
 * so a source reading whole blocks can apply the same filters column by column, before it builds any item.
 */
export interface EvmMatcher {
  (batch: EvmBatch): EvmBatch;
  readonly query: EvmQuery;
  readonly logs: LogSets;
  readonly joinLogs: LogSets;
  readonly transactions: AddressSets;
  readonly traces: AddressSets;
}

export function evmMatcher(query: EvmQuery): EvmMatcher {
  const logs = logSets(query.join ? query.logs.filter((f) => !f.join) : query.logs);
  const joinLogs = logSets(query.join ? query.logs.filter((f) => f.join) : []);
  const transactions = addressSets(query.transactions);
  const traces = addressSets(query.traces ?? []);
  const plainLog = (l: EvmLog) => logMatches(logs, l.address, l.topics);
  const joinLog = (l: EvmLog) => logMatches(joinLogs, l.address, l.topics);
  const match = (batch: EvmBatch): EvmBatch => {
    const batchTraces = batch.traces ?? [];
    const whole = new Set<string>();
    if (query.join) {
      for (const t of batch.transactions) if (addressMatches(transactions, t.from, t.to)) whole.add(t.hash);
      for (const l of batch.logs) if (joinLog(l)) whole.add(l.transactionHash);
      for (const t of batchTraces) if (addressMatches(traces, t.from, t.to)) whole.add(t.transactionHash);
    }
    const matchedLogs = batch.logs.filter((l) => whole.has(l.transactionHash) || plainLog(l));
    const ofLogs = new Set(query.includeLogTransactions ? matchedLogs.filter(plainLog).map((l) => l.transactionHash) : []);
    const matchedTransactions = batch.transactions.filter((t) => whole.has(t.hash) || ofLogs.has(t.hash) || addressMatches(transactions, t.from, t.to));
    const matchedTraces = batchTraces.filter((t) => whole.has(t.transactionHash) || addressMatches(traces, t.from, t.to));
    const used = new Set([...matchedLogs, ...matchedTransactions, ...matchedTraces].map((x) => x.blockNumber));
    return { ...batch, blocks: batch.blocks.filter((b) => used.has(b.number)), transactions: matchedTransactions, logs: matchedLogs, traces: matchedTraces };
  };
  return Object.assign(match, { query, logs, joinLogs, transactions, traces });
}

/**
 * A matcher over every batch of a `wholeBlocksQuery(query)` fetch. The batch as read is dropped before the matched one
 * is handed on: a generator frame would keep it alive while the caller processes the matched batch.
 */
export async function* matchEvmBatches(batches: AsyncIterable<EvmBatch>, match: (batch: EvmBatch) => EvmBatch): AsyncGenerator<EvmBatch> {
  const iterator = batches[Symbol.asyncIterator]();
  for (let matched = await nextMatched(iterator, match); matched; matched = await nextMatched(iterator, match)) yield matched;
}

async function nextMatched(iterator: AsyncIterator<EvmBatch>, match: (batch: EvmBatch) => EvmBatch): Promise<EvmBatch | undefined> {
  const next = await iterator.next();
  if (next.done) return undefined;
  return match(next.value);
}

/**
 * HyperSync filter semantics (`from` AND `to`, each an OR list, empty = any; filters OR'ed) over Sets: the filters
 * that name only senders or only recipients (one per address chunk) become one Set each.
 */
export interface AddressSets {
  any: boolean;
  senders: Set<string>;
  recipients: Set<string>;
  pairs: Array<{ from: Set<string>; to: Set<string> }>;
}

function addressSets(filters: EvmTxFilter[]): AddressSets {
  const sets: AddressSets = { any: false, senders: new Set(), recipients: new Set(), pairs: [] };
  for (const f of filters) {
    const from = f.from ?? [];
    const to = f.to ?? [];
    if (from.length === 0 && to.length === 0) sets.any = true;
    else if (to.length === 0) for (const a of from) sets.senders.add(lower(a));
    else if (from.length === 0) for (const a of to) sets.recipients.add(lower(a));
    else sets.pairs.push({ from: new Set(from.map(lower)), to: new Set(to.map(lower)) });
  }
  return sets;
}

function addressMatches(sets: AddressSets, from: string, to: string | null): boolean {
  if (sets.any) return true;
  const f = lower(from);
  const t = to === null ? null : lower(to);
  if (sets.senders.has(f) || (t !== null && sets.recipients.has(t))) return true;
  return sets.pairs.some((p) => p.from.has(f) && t !== null && p.to.has(t));
}

/** Log filter semantics over Sets: filters constraining only the address, or only one topic position, are merged. */
export interface LogSets {
  any: boolean;
  addresses: Set<string>;
  topics: Set<string>[];
  rest: Array<{ address: Set<string> | undefined; topics: Array<Set<string> | undefined> }>;
}

function logSets(filters: EvmLogFilter[]): LogSets {
  const sets: LogSets = { any: false, addresses: new Set(), topics: [new Set(), new Set(), new Set(), new Set()], rest: [] };
  for (const f of filters) {
    const address = f.address?.length ? new Set(f.address.map(lower)) : undefined;
    const positions = (f.topics ?? []).map((alts) => (alts?.length ? new Set(alts.map(lower)) : undefined));
    const constrained = positions.filter((p) => p !== undefined).length + (address ? 1 : 0);
    if (constrained === 0) sets.any = true;
    else if (constrained > 1) sets.rest.push({ address, topics: positions });
    else if (address) for (const a of address) sets.addresses.add(a);
    else positions.forEach((set, i) => set?.forEach((t) => sets.topics[i]?.add(t)));
  }
  return sets;
}

function logMatches(sets: LogSets, logAddress: string, logTopics: readonly string[]): boolean {
  if (sets.any) return true;
  const address = lower(logAddress);
  const topics = logTopics.map(lower);
  const topicIn = (set: Set<string>, i: number) => {
    const topic = topics[i];
    return topic !== undefined && set.has(topic);
  };
  if (sets.addresses.has(address) || sets.topics.some(topicIn)) return true;
  return sets.rest.some((f) => (!f.address || f.address.has(address)) && f.topics.every((set, i) => !set || topicIn(set, i)));
}
