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
 * matching a block, so a matcher is reused across batches and polls while the query is the same.
 */
export function evmMatcher(query: EvmQuery): (batch: EvmBatch) => EvmBatch {
  const plainLog = logMatcher(query.join ? query.logs.filter((f) => !f.join) : query.logs);
  const joinLog = logMatcher(query.join ? query.logs.filter((f) => f.join) : []);
  const tx = addressMatcher(query.transactions);
  const trace = addressMatcher(query.traces ?? []);
  return (batch) => {
    const traces = batch.traces ?? [];
    const whole = new Set<string>();
    if (query.join) {
      for (const t of batch.transactions) if (tx(t.from, t.to)) whole.add(t.hash);
      for (const l of batch.logs) if (joinLog(l)) whole.add(l.transactionHash);
      for (const t of traces) if (trace(t.from, t.to)) whole.add(t.transactionHash);
    }
    const logs = batch.logs.filter((l) => whole.has(l.transactionHash) || plainLog(l));
    const ofLogs = new Set(query.includeLogTransactions ? logs.filter(plainLog).map((l) => l.transactionHash) : []);
    const transactions = batch.transactions.filter((t) => whole.has(t.hash) || ofLogs.has(t.hash) || tx(t.from, t.to));
    const matchedTraces = traces.filter((t) => whole.has(t.transactionHash) || trace(t.from, t.to));
    const used = new Set([...logs, ...transactions, ...matchedTraces].map((x) => x.blockNumber));
    return { ...batch, blocks: batch.blocks.filter((b) => used.has(b.number)), transactions, logs, traces: matchedTraces };
  };
}

/** A matcher over every batch of a `wholeBlocksQuery(query)` fetch. */
export async function* matchEvmBatches(batches: AsyncIterable<EvmBatch>, match: (batch: EvmBatch) => EvmBatch): AsyncGenerator<EvmBatch> {
  for await (const batch of batches) yield match(batch);
}

/**
 * HyperSync filter semantics (`from` AND `to`, each an OR list, empty = any; filters OR'ed) over Sets: the filters
 * that name only senders or only recipients (one per address chunk) become one Set each.
 */
function addressMatcher(filters: EvmTxFilter[]): (from: string, to: string | null) => boolean {
  const senders = new Set<string>();
  const recipients = new Set<string>();
  const pairs: Array<{ from: Set<string>; to: Set<string> }> = [];
  let any = false;
  for (const f of filters) {
    const from = f.from ?? [];
    const to = f.to ?? [];
    if (from.length === 0 && to.length === 0) any = true;
    else if (to.length === 0) for (const a of from) senders.add(lower(a));
    else if (from.length === 0) for (const a of to) recipients.add(lower(a));
    else pairs.push({ from: new Set(from.map(lower)), to: new Set(to.map(lower)) });
  }
  return (from, to) => {
    if (any) return true;
    const f = lower(from);
    const t = to === null ? null : lower(to);
    if (senders.has(f) || (t !== null && recipients.has(t))) return true;
    return pairs.some((p) => p.from.has(f) && t !== null && p.to.has(t));
  };
}

/** Log filter semantics over Sets: filters constraining only the address, or only one topic position, are merged. */
function logMatcher(filters: EvmLogFilter[]): (log: EvmLog) => boolean {
  const addresses = new Set<string>();
  const topics = [new Set<string>(), new Set<string>(), new Set<string>(), new Set<string>()];
  const rest: Array<{ address: Set<string> | undefined; topics: Array<Set<string> | undefined> }> = [];
  let any = false;
  for (const f of filters) {
    const address = f.address?.length ? new Set(f.address.map(lower)) : undefined;
    const positions = (f.topics ?? []).map((alts) => (alts?.length ? new Set(alts.map(lower)) : undefined));
    const constrained = positions.filter((p) => p !== undefined).length + (address ? 1 : 0);
    if (constrained === 0) any = true;
    else if (constrained > 1) rest.push({ address, topics: positions });
    else if (address) for (const a of address) addresses.add(a);
    else positions.forEach((set, i) => set?.forEach((t) => topics[i]?.add(t)));
  }
  return (log) => {
    if (any) return true;
    const address = lower(log.address);
    const logTopics = log.topics.map(lower);
    const topicIn = (set: Set<string>, i: number) => {
      const topic = logTopics[i];
      return topic !== undefined && set.has(topic);
    };
    if (addresses.has(address) || topics.some(topicIn)) return true;
    return rest.some((f) => (!f.address || f.address.has(address)) && f.topics.every((set, i) => !set || topicIn(set, i)));
  };
}
