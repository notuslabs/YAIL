import type { Abi, AbiEvent } from "viem";
import type { AddressSpec, ChainConfig, Config } from "../config/types.js";
import { factorySetName, isAddressSet, isFactory, type FactoryRef } from "../config/address.js";
import type { AddressRegistry } from "../addresses/registry.js";
import type { BitcoinQuery, EvmLogFilter, EvmQuery, EvmTraceFilter, EvmTxFilter, SolanaQuery, SourceKind } from "../sources/types.js";
import { abiEvents, compileFilter, eventTopic, padAddress, type CompiledEvent, type CompiledFilter } from "./events.js";
import { perChain } from "../config/chain-ref.js";
import { chunkList, normalizeHex, toArray } from "../util.js";

export interface ContractSource {
  kind: "contract";
  name: string;
  chain: string;
  abi: Abi;
  address?: AddressSpec;
  startBlock: number;
  endBlock?: number;
  /** Events that have at least one handler. */
  events: CompiledEvent[];
  filters: CompiledFilter[];
  includeTransactions: boolean;
  factory?: { ref: FactoryRef; topic0: string; event: AbiEvent; set: string };
}

export interface AccountSource {
  kind: "account";
  name: string;
  chain: string;
  address: AddressSpec;
  startBlock: number;
  endBlock?: number;
  activity: boolean;
}

export interface ChainPlan {
  chain: string;
  config: ChainConfig;
  kind: SourceKind;
  contracts: ContractSource[];
  accounts: AccountSource[];
  /** Earliest block any source starts at. */
  startBlock: number;
  /** Set when every source has an endBlock. */
  endBlock?: number;
  /** Address sets referenced on this chain -> default fromBlock. */
  sets: Map<string, number>;
}

export interface PlanOptions {
  /** Names of events with registered handlers, e.g. "Erc20:Transfer", "Wallets:transaction". */
  handled: Set<string>;
  resolveLatest: (chain: string) => number;
}

export function buildPlans(config: Config, options: PlanOptions): Map<string, ChainPlan> {
  const plans = new Map<string, ChainPlan>();
  for (const [chain, cfg] of Object.entries(config.chains)) {
    plans.set(chain, { chain, config: cfg, kind: cfg.source.kind, contracts: [], accounts: [], startBlock: Number.MAX_SAFE_INTEGER, sets: new Map() });
  }
  const resolveBlock = (chain: string, v: number | "latest" | undefined, fallback: number): number => {
    if (v === "latest") return options.resolveLatest(chain);
    return v ?? fallback;
  };

  for (const [name, c] of Object.entries(config.contracts ?? {})) {
    for (const [chain, override] of Object.entries(perChain(c.chain))) {
      const plan = plans.get(chain)!;
      if (plan.kind !== "evm") throw new Error(`contract "${name}": chain "${chain}" is not an EVM chain`);
      const events = abiEvents(c.abi)
        .filter((e) => options.handled.has(`${name}:${e.name}`))
        .map((e) => ({ name: e.name, abi: e, topic0: eventTopic(e) }));
      const rawFilters = override.filter ?? c.filter;
      const filters = toArray(rawFilters ?? []).map((f) => compileFilter(c.abi, f));
      const address = override.address ?? c.address;
      const startBlock = resolveBlock(chain, override.startBlock ?? c.startBlock, 0);
      const endBlock = override.endBlock ?? c.endBlock;
      const source: ContractSource = { kind: "contract", name, chain, abi: c.abi, address, startBlock, endBlock, events, filters, includeTransactions: c.includeTransactions ?? false };
      if (isFactory(address)) {
        source.factory = { ref: address, topic0: eventTopic(address.event), event: address.event, set: factorySetName(name) };
      }
      if (isAddressSet(address)) noteSet(plan, address.set, startBlock);
      for (const f of filters) for (const t of f.topics) if (t.set) noteSet(plan, t.set, startBlock);
      if (events.length === 0) continue; // nothing handled: skip fetching entirely
      plan.contracts.push(source);
      plan.startBlock = Math.min(plan.startBlock, startBlock);
      plan.endBlock = mergeEnd(plan, endBlock);
    }
  }

  for (const [name, a] of Object.entries(config.accounts ?? {})) {
    if (!options.handled.has(`${name}:transaction`)) continue;
    for (const [chain, override] of Object.entries(perChain(a.chain))) {
      const plan = plans.get(chain)!;
      const address = override.address ?? a.address;
      const startBlock = resolveBlock(chain, override.startBlock ?? a.startBlock, 0);
      const endBlock = override.endBlock ?? a.endBlock;
      if (isAddressSet(address)) noteSet(plan, address.set, startBlock);
      plan.accounts.push({ kind: "account", name, chain, address, startBlock, endBlock, activity: a.activity ?? false });
      plan.startBlock = Math.min(plan.startBlock, startBlock);
      plan.endBlock = mergeEnd(plan, endBlock);
    }
  }

  for (const plan of plans.values()) {
    if (plan.startBlock === Number.MAX_SAFE_INTEGER) plan.startBlock = 0;
    if (plan.contracts.length + plan.accounts.length === 0) plan.endBlock = undefined;
  }
  return plans;
}

function noteSet(plan: ChainPlan, set: string, startBlock: number): void {
  plan.sets.set(set, Math.min(plan.sets.get(set) ?? Number.MAX_SAFE_INTEGER, startBlock));
}

function mergeEnd(plan: ChainPlan, end: number | undefined): number | undefined {
  // Only meaningful when every source has an endBlock; any open-ended source makes the chain open-ended.
  const sources = [...plan.contracts, ...plan.accounts];
  if (sources.some((s) => s.endBlock === undefined)) return undefined;
  return Math.max(plan.endBlock ?? 0, end ?? 0);
}

/** Next block at which the set of active sources changes (a later startBlock or an endBlock). */
export function nextBoundary(plan: ChainPlan, from: number): number | undefined {
  let next: number | undefined;
  for (const s of [...plan.contracts, ...plan.accounts]) {
    const boundaries = [s.startBlock];
    if (s.endBlock !== undefined) boundaries.push(s.endBlock + 1);
    for (const b of boundaries) {
      if (b > from && (next === undefined || b < next)) next = b;
    }
  }
  return next;
}

export interface QueryBuildOptions {
  /** Restrict the query to sources referencing this set, substituting its members. Used for address backfills. */
  override?: { set: string; addresses: string[] };
  addressChunk?: number;
}

/** Resolve the address list of a spec on a chain (empty = "match everything" for static specs). */
export function resolveAddresses(spec: AddressSpec | undefined, chain: string, registry: AddressRegistry, override?: QueryBuildOptions["override"], factorySet?: string): { any: boolean; addresses: string[]; set?: string } {
  if (spec === undefined) return { any: true, addresses: [] };
  if (typeof spec === "string") return { any: false, addresses: [normalizeHex(spec)] };
  if (Array.isArray(spec)) return { any: false, addresses: (spec as readonly string[]).map(normalizeHex) };
  if (isAddressSet(spec) || isFactory(spec)) {
    const set = isAddressSet(spec) ? spec.set : factorySet;
    if (set === undefined) throw new Error("factory addresses require the contract's set");
    if (override && override.set === set) return { any: false, addresses: override.addresses, set };
    return { any: false, addresses: registry.live(set, chain), set };
  }
  return { any: true, addresses: [] };
}

export function buildEvmQuery(plan: ChainPlan, from: number, to: number, registry: AddressRegistry, options: QueryBuildOptions = {}): EvmQuery {
  const chunk = options.addressChunk ?? 500;
  const logs: EvmLogFilter[] = [];
  const transactions: EvmTxFilter[] = [];
  const traces: EvmTraceFilter[] = [];
  let includeLogTransactions = false;
  let join = false;
  const override = options.override;

  for (const c of plan.contracts) {
    if (!(c.startBlock < to && (c.endBlock === undefined || c.endBlock >= from))) continue;
    const usesOverride =
      override !== undefined &&
      ((isAddressSet(c.address) && c.address.set === override.set) ||
        (c.factory !== undefined && c.factory.set === override.set) ||
        c.filters.some((f) => f.topics.some((t) => t.set === override.set)));
    if (override && !usesOverride) continue;
    if (c.includeTransactions) includeLogTransactions = true;

    // Factory contract's own creation event (live mode only).
    if (c.factory && !override) {
      const factoryAddrs = toArray(c.factory.ref.address).map((a) => a.toLowerCase());
      logs.push({ address: factoryAddrs, topics: [[c.factory.topic0]] });
    }
    if (c.events.length === 0) continue;
    const topic0s = c.events.map((e) => e.topic0);
    const resolved = resolveAddresses(c.address, plan.chain, registry, override, c.factory?.set);
    if (!resolved.any && resolved.addresses.length === 0) continue; // empty dynamic set: nothing to fetch yet
    let addressChunks: Array<string[] | undefined> = [undefined];
    if (!resolved.any) addressChunks = chunkList(resolved.addresses, chunk);

    if (c.filters.length === 0) {
      for (const addrs of addressChunks) logs.push({ address: addrs, topics: [topic0s] });
      continue;
    }
    for (const f of c.filters) {
      if (!topic0s.includes(f.topic0)) continue; // filter on an unhandled event
      // Expand each set-based topic into chunks; static values as-is.
      const perTopic: Array<{ index: number; chunks: string[][] }> = [];
      let empty = false;
      for (const t of f.topics) {
        if (t.set !== undefined) {
          let members = registry.live(t.set, plan.chain);
          if (override && override.set === t.set) members = override.addresses;
          if (members.length === 0) {
            empty = true;
            break;
          }
          perTopic.push({ index: t.index, chunks: chunkList(members.map(padAddress), chunk) });
        } else {
          perTopic.push({ index: t.index, chunks: [t.values ?? []] });
        }
      }
      if (empty) continue;
      for (const combo of cartesian(perTopic.map((p) => p.chunks))) {
        const topics: Array<string[] | null> = [[f.topic0]];
        perTopic.forEach((p, i) => {
          while (topics.length <= p.index) topics.push(null);
          topics[p.index] = combo[i]!;
        });
        for (const addrs of addressChunks) logs.push({ address: addrs, topics });
      }
    }
  }

  for (const a of plan.accounts) {
    if (!(a.startBlock < to && (a.endBlock === undefined || a.endBlock >= from))) continue;
    const usesOverride = override !== undefined && isAddressSet(a.address) && a.address.set === override.set;
    if (override && !usesOverride) continue;
    const resolved = resolveAddresses(a.address, plan.chain, registry, override);
    if (resolved.addresses.length === 0) continue;
    for (const addrs of chunkList(resolved.addresses, chunk)) {
      transactions.push({ from: addrs });
      transactions.push({ to: addrs });
      if (!a.activity) continue;
      const padded = addrs.map(padAddress);
      logs.push({ topics: [null, padded], join: true }, { topics: [null, null, padded], join: true }, { topics: [null, null, null, padded], join: true });
      traces.push({ from: addrs }, { to: addrs });
    }
    if (a.activity) join = true;
  }

  return { fromBlock: from, toBlock: to, logs, transactions, traces, includeLogTransactions, join };
}

/** Bitcoin and Solana queries: the addresses of every account source active in the range. */
export function buildAddressQuery(plan: ChainPlan, from: number, to: number, registry: AddressRegistry, options: QueryBuildOptions = {}): BitcoinQuery & SolanaQuery {
  const addresses = new Set<string>();
  for (const a of plan.accounts) {
    if (!(a.startBlock < to && (a.endBlock === undefined || a.endBlock >= from))) continue;
    const usesOverride = options.override !== undefined && isAddressSet(a.address) && a.address.set === options.override.set;
    if (options.override && !usesOverride) continue;
    const resolved = resolveAddresses(a.address, plan.chain, registry, options.override);
    for (const x of resolved.addresses) addresses.add(x);
  }
  return { fromBlock: from, toBlock: to, addresses: [...addresses] };
}

function cartesian<T>(lists: T[][]): T[][] {
  return lists.reduce<T[][]>((acc, list) => acc.flatMap((prefix) => list.map((x) => [...prefix, x])), [[]]);
}
