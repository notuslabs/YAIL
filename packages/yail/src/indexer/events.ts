import { decodeEventLog, encodeAbiParameters, toEventSelector, type Abi, type AbiEvent, type ContractEventName, type DecodeEventLogReturnType } from "viem";
import type { Config, EventFilter, ProgramConfig } from "../config/types.js";
import type { BitcoinTransaction, EvmBlock, EvmLog, EvmTrace, EvmTransaction, SolanaBalance, SolanaBlock, SolanaInstruction, SolanaLog, SolanaTransaction, StellarEvent, StellarLedger, StellarTransaction } from "../sources/types.js";
import type { EventDef, InstructionDef } from "../solana/program.js";
import { isAddressSet } from "../config/address.js";
import { walletOf } from "../sources/solana/shared.js";
import { toArray } from "../util.js";

// ------------------------------------------------------------ type level

type ContractsOf<C extends Config<any, any, any>> = NonNullable<C["contracts"]>;
type AccountsOf<C extends Config<any, any, any>> = NonNullable<C["accounts"]>;
type ProgramsOf<C extends Config<any, any, any>> = NonNullable<C["programs"]>;

export type ContractEventNames<C extends Config<any, any, any>> = {
  [K in keyof ContractsOf<C> & string]: `${K}:${ContractEventName<ContractsOf<C>[K]["abi"]>}`;
}[keyof ContractsOf<C> & string];

export type AccountEventNames<C extends Config<any, any, any>> = {
  [K in keyof AccountsOf<C> & string]: `${K}:transaction`;
}[keyof AccountsOf<C> & string];

export type ProgramEventNames<C extends Config<any, any, any>> = {
  [K in keyof ProgramsOf<C> & string]: `${K}:${(keyof NonNullable<ProgramsOf<C>[K]["instructions"]> | keyof NonNullable<ProgramsOf<C>[K]["events"]>) & string}`;
}[keyof ProgramsOf<C> & string];

export type EventNames<C extends Config<any, any, any>> = ContractEventNames<C> | AccountEventNames<C> | ProgramEventNames<C> | "setup";

export interface ContractEvent<abi extends Abi = Abi, name extends string = string> {
  /** Event name as in the ABI. */
  name: name;
  /** Decoded, typed arguments. */
  args: name extends ContractEventName<abi> ? DecodeEventLogReturnType<abi, name>["args"] : Record<string, unknown>;
  /** Emitting contract, lowercase. */
  address: string;
  log: EvmLog;
  block: EvmBlock;
  /** Present when the contract sets `includeTransactions: true`. */
  transaction?: EvmTransaction;
}

export interface EvmAccountEvent {
  /** The matched account address (lowercase). */
  address: string;
  /** How the transaction involves the account: it sent it, received it, both, or (with `activity`) only appears in its logs or traces. */
  direction: "from" | "to" | "self" | "activity";
  transaction: EvmTransaction;
  block: EvmBlock;
  /** Every log of the transaction, in order. Empty unless the account sets `activity: true`. */
  logs: EvmLog[];
  /** Every trace of the transaction, when the source serves traces. Empty unless the account sets `activity: true`. */
  traces: EvmTrace[];
}

export interface BitcoinAccountEvent {
  /** The matched account address. */
  address: string;
  tx: BitcoinTransaction;
  block: { height: number; hash: string; time: number };
  /** Sum of outputs paying the address, in satoshis. */
  received: bigint;
  /** Sum of inputs spent from the address, in satoshis. */
  sent: bigint;
  /** received - sent (negative when the address paid out). */
  net: bigint;
  fee: bigint;
  /** True when the address funded at least one input. */
  isSender: boolean;
}

export interface SolanaAccountEvent {
  /** The matched wallet. */
  address: string;
  transaction: SolanaTransaction;
  block: SolanaBlock;
  /** The wallet's own account and the token accounts it owns, where they changed, before and after. */
  balances: SolanaBalance[];
  /** Change of the wallet's SOL, in lamports (the fee included when the wallet paid it). */
  lamports: bigint;
  /** Token accounts of the wallet whose balance changed, with the change in raw token units. */
  tokens: Array<{ account: string; mint: string; decimals: number; delta: bigint }>;
}

export interface StellarAccountEvent {
  /** The matched account. */
  address: string;
  transaction: StellarTransaction;
  ledger: StellarLedger;
  /** Every event of the transaction, in order. */
  events: StellarEvent[];
  /**
   * The account's balance changes from the transaction's transfer, mint, burn, clawback and fee events, one per asset:
   * `native` (XLM, in stroops), `CODE:ISSUER` for a classic asset, the token contract (C…) for any other token.
   */
  deltas: Array<{ asset: string; amount: bigint }>;
}

export interface SolanaInstructionEvent<args = unknown, account extends string = string> {
  /** The instruction's key in the program config. */
  name: string;
  program: string;
  /** Decoded with the definition's `args` codec, from the bytes after the discriminator. */
  args: args;
  /** The definition's account names, bound to the instruction's accounts in order. */
  accounts: Record<account, string>;
  /** Every account the instruction got, in order. */
  accountList: string[];
  /** Hex, without `0x`. */
  data: string;
  /** Position in the transaction: `[2]` is its third top-level instruction, `[2, 0]` the first inner one that one made. */
  address: number[];
  isInner: boolean;
  /** Index of this instruction in `programInstructions`. */
  ordinal: number;
  /** The instructions of this program and this config entry in the transaction, by address. */
  programInstructions: SolanaInstruction[];
  /** With `includeLogs`: every log line this program wrote in the transaction, in order. Empty otherwise. */
  programLogs: SolanaLog[];
  transaction: SolanaTransaction;
  block: SolanaBlock;
  /** With `includeBalances`: every SOL and token balance change of the transaction. Empty otherwise. */
  balances: SolanaBalance[];
}

export interface SolanaProgramEvent<data = unknown> {
  /** The event's key in the program config. */
  name: string;
  program: string;
  /** Decoded with the definition's `data` codec, from the bytes after the discriminator. */
  data: data;
  /** The instruction that emitted it. Null for a log line before slot 416,000,000, where HyperSync did not record it. */
  address: number[] | null;
  transaction: SolanaTransaction;
  block: SolanaBlock;
  /** With `includeBalances`: every SOL and token balance change of the transaction. Empty otherwise. */
  balances: SolanaBalance[];
}

export interface SetupEvent {
  /** Block the chain starts (or resumes) indexing from. */
  block: number;
}

/** Chain names a `chain` field refers to: the name, or the keys of a per-chain map (`string` for a map built at runtime). */
type RefNames<ref> = ref extends string ? ref : keyof ref & string;

/**
 * Kind of the chain `name`, an optional key (`{ solana?: … }`) included. A name the chains' type does not have is
 * the kind of its string index signature, or EVM when it has none: spreading a map built at runtime
 * (`{ ...Object.fromEntries(…), ...{ bitcoin?: … } }`) drops the map's index signature, and with it its chains.
 */
type ChainKind<C extends Config<any, any, any>, name extends string> = name extends keyof C["chains"]
  ? NonNullable<C["chains"][name]>["source"]["kind"]
  : string extends keyof C["chains"]
    ? NonNullable<C["chains"][string]>["source"]["kind"]
    : "evm";

type AccountEventByKind = { evm: EvmAccountEvent; bitcoin: BitcoinAccountEvent; solana: SolanaAccountEvent; stellar: StellarAccountEvent };

export type AccountEventOf<C extends Config<any, any, any>, K extends keyof AccountsOf<C>> = AccountEventByKind[ChainKind<C, RefNames<AccountsOf<C>[K]["chain"]>> & keyof AccountEventByKind];

export type ProgramEventOf<P extends ProgramConfig<any, any>, E extends string> = E extends keyof NonNullable<P["instructions"]>
  ? NonNullable<P["instructions"]>[E] extends InstructionDef<infer args, infer account>
    ? SolanaInstructionEvent<args, account>
    : never
  : E extends keyof NonNullable<P["events"]>
    ? NonNullable<P["events"]>[E] extends EventDef<infer data>
      ? SolanaProgramEvent<data>
      : never
    : never;

export type EventOf<C extends Config<any, any, any>, name extends string> = name extends "setup"
  ? SetupEvent
  : name extends `${infer K}:${infer E}`
    ? K extends keyof ContractsOf<C>
      ? ContractEvent<ContractsOf<C>[K]["abi"], E>
      : K extends keyof AccountsOf<C>
        ? AccountEventOf<C, K>
        : K extends keyof ProgramsOf<C>
          ? ProgramEventOf<ProgramsOf<C>[K], E>
          : never
    : never;

type ReferencedChains<entries> = { [K in keyof entries]: entries[K] extends { chain: infer ref } ? RefNames<ref> : never }[keyof entries];

/** The chains' names and the names contracts, accounts and programs refer to: a map spread into `chains` loses its names in the type, the references keep them (`string` for a map built at runtime). */
export type ChainNames<C extends Config<any, any, any>> = (keyof C["chains"] & string) | ReferencedChains<ContractsOf<C>> | ReferencedChains<AccountsOf<C>> | ReferencedChains<ProgramsOf<C>>;

// ------------------------------------------------------------ runtime

export interface CompiledFilter {
  event: AbiEvent;
  topic0: string;
  /** topic position (1..3) -> allowed values (padded hex) or an address set name. */
  topics: Array<{ index: number; values?: string[]; set?: string }>;
}

export interface CompiledEvent {
  name: string;
  abi: AbiEvent;
  topic0: string;
}

export function eventTopic(event: AbiEvent): string {
  return toEventSelector(event).toLowerCase();
}

export function abiEvents(abi: Abi): AbiEvent[] {
  return abi.filter((x): x is AbiEvent => x.type === "event");
}

export function compileFilter(abi: Abi, filter: EventFilter): CompiledFilter {
  const event = abiEvents(abi).find((e) => e.name === filter.event);
  if (!event) throw new Error(`filter: unknown event ${filter.event}`);
  const indexed = event.inputs.filter((i) => i.indexed);
  const topics: CompiledFilter["topics"] = [];
  for (const [name, value] of Object.entries(filter.args ?? {})) {
    const idx = indexed.findIndex((i) => i.name === name);
    if (idx < 0) throw new Error(`filter: ${filter.event}.${name} is not an indexed parameter`);
    const input = indexed[idx]!;
    if (isAddressSet(value)) {
      if (input.type !== "address") throw new Error(`filter: ${filter.event}.${name} must be an address to use addressSet()`);
      topics.push({ index: idx + 1, set: value.set });
    } else {
      topics.push({ index: idx + 1, values: toArray(value).map((v) => encodeTopicValue(input.type, v)) });
    }
  }
  return { event, topic0: eventTopic(event), topics };
}

export function encodeTopicValue(type: string, value: string | number | bigint | boolean): string {
  if (type === "address") return `0x${"0".repeat(24)}${String(value).toLowerCase().replace(/^0x/, "")}`;
  if (type.startsWith("bytes") && type !== "bytes") return String(value).toLowerCase().padEnd(66, "0");
  return encodeAbiParameters([{ type }], [value as any]).toLowerCase();
}

export function padAddress(address: string): string {
  return `0x${"0".repeat(24)}${address.toLowerCase().replace(/^0x/, "")}`;
}

export function unpadAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

export function decodeLog(event: AbiEvent, log: EvmLog): { args: Record<string, unknown> } | null {
  try {
    const decoded = decodeEventLog({ abi: [event], data: log.data as `0x${string}`, topics: log.topics as [`0x${string}`, ...`0x${string}`[]], strict: false });
    return { args: (decoded.args ?? {}) as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** Does a log satisfy a compiled filter? `inSet` resolves address-set membership. */
export function logMatchesFilter(log: EvmLog, filter: CompiledFilter, inSet: (set: string, address: string) => boolean): boolean {
  if ((log.topics[0] ?? "").toLowerCase() !== filter.topic0) return false;
  for (const t of filter.topics) {
    const topic = log.topics[t.index]?.toLowerCase();
    if (!topic) return false;
    if (t.set !== undefined) {
      if (!inSet(t.set, unpadAddress(topic))) return false;
    } else if (t.values && !t.values.includes(topic)) return false;
  }
  return true;
}

/** Addresses a transaction involves: its sender, its recipient, and every address in the given logs' topics and traces. */
export function involvedAddresses(tx: EvmTransaction, logs: EvmLog[], traces: EvmTrace[]): string[] {
  const mentioned = [...logs.flatMap((l) => l.topics.slice(1).map(unpadAddress)), ...traces.flatMap((t) => [t.from, t.to])];
  return [...new Set([tx.from, tx.to, ...mentioned].filter((a): a is string => a !== null))];
}

export function directionOf(tx: EvmTransaction, address: string): EvmAccountEvent["direction"] {
  if (tx.from === address && tx.to === address) return "self";
  if (tx.from === address) return "from";
  if (tx.to === address) return "to";
  return "activity";
}

export function bitcoinAccountEvent(tx: BitcoinTransaction, address: string): BitcoinAccountEvent | null {
  let received = 0n;
  let sent = 0n;
  let isSender = false;
  for (const o of tx.vout) if (o.address === address) received += o.value;
  for (const i of tx.vin) {
    if (i.prevout?.address === address) {
      sent += i.prevout.value;
      isSender = true;
    }
  }
  if (received === 0n && sent === 0n) return null;
  return { address, tx, block: { height: tx.blockHeight, hash: tx.blockHash, time: tx.blockTime }, received, sent, net: received - sent, fee: tx.fee, isSender };
}

/** The account's view of a transaction, or null when none of its events names the account. */
export function stellarAccountEvent(transaction: StellarTransaction, ledger: StellarLedger, events: StellarEvent[], address: string): StellarAccountEvent | null {
  if (!events.some((e) => e.contract === address || e.topics.includes(address))) return null;
  const byAsset = new Map<string, bigint>();
  for (const move of events.flatMap(movements)) {
    if (move.address === address) byAsset.set(move.asset, (byAsset.get(move.asset) ?? 0n) + move.amount);
  }
  const deltas = [...byAsset].filter(([, amount]) => amount !== 0n).map(([asset, amount]) => ({ asset, amount }));
  return { address, transaction, ledger, events, deltas };
}

/**
 * What a CAP-67 or SEP-41 token event moves. Topics are the event name, its parties, then (Stellar Asset Contracts)
 * the asset as `native` or `CODE:ISSUER`; older contracts put an admin before the party of a mint or a clawback, so
 * those take the last party. A fee event charges XLM (negative data: a refund).
 */
function movements(event: StellarEvent): Array<{ address: string; asset: string; amount: bigint }> {
  const [name, ...rest] = event.topics;
  const amount = typeof event.data === "bigint" ? event.data : (event.data as { amount?: unknown } | null)?.amount;
  if (typeof amount !== "bigint") return [];
  const last = rest.at(-1);
  const named = typeof last === "string" && (last === "native" || last.includes(":"));
  const asset = named ? last : event.contract;
  const parties = (named ? rest.slice(0, -1) : rest).filter((t): t is string => typeof t === "string");
  const party = parties.at(-1);
  if (party === undefined) return [];
  if (name === "transfer" && parties.length >= 2) return [{ address: parties[0]!, asset, amount: -amount }, { address: parties[1]!, asset, amount }];
  if (name === "mint") return [{ address: party, asset, amount }];
  if (name === "burn" || name === "clawback") return [{ address: party, asset, amount: -amount }];
  if (name === "fee") return [{ address: parties[0]!, asset: "native", amount: -amount }];
  return [];
}

/** The wallet's slice of a transaction's balances, or null when the transaction has none. */
export function solanaAccountEvent(transaction: SolanaTransaction, block: SolanaBlock, rows: SolanaBalance[], address: string): SolanaAccountEvent | null {
  const balances = rows.filter((b) => walletOf(b) === address);
  if (balances.length === 0) return null;
  let lamports = 0n;
  const tokens: SolanaAccountEvent["tokens"] = [];
  for (const b of balances) {
    if (!b.token) lamports += (b.lamports?.post ?? 0n) - (b.lamports?.pre ?? 0n);
    else if (b.token.post !== b.token.pre) tokens.push({ account: b.account, mint: b.token.mint, decimals: b.token.decimals, delta: b.token.post - b.token.pre });
  }
  return { address, transaction, block, balances, lamports, tokens };
}
