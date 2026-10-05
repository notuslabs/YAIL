import { decodeEventLog, encodeAbiParameters, toEventSelector, type Abi, type AbiEvent, type ContractEventName, type DecodeEventLogReturnType } from "viem";
import type { Config, EventFilter } from "../config/types.js";
import type { BitcoinTransaction, EvmBlock, EvmLog, EvmTrace, EvmTransaction } from "../sources/types.js";
import { isAddressSet } from "../config/address.js";
import { toArray } from "../util.js";

// ------------------------------------------------------------ type level

type ContractsOf<C extends Config<any, any, any>> = NonNullable<C["contracts"]>;
type AccountsOf<C extends Config<any, any, any>> = NonNullable<C["accounts"]>;

export type ContractEventNames<C extends Config<any, any, any>> = {
  [K in keyof ContractsOf<C> & string]: `${K}:${ContractEventName<ContractsOf<C>[K]["abi"]>}`;
}[keyof ContractsOf<C> & string];

export type AccountEventNames<C extends Config<any, any, any>> = {
  [K in keyof AccountsOf<C> & string]: `${K}:transaction`;
}[keyof AccountsOf<C> & string];

export type EventNames<C extends Config<any, any, any>> = ContractEventNames<C> | AccountEventNames<C> | "setup";

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

export interface SetupEvent {
  /** Block the chain starts (or resumes) indexing from. */
  block: number;
}

type ChainKind<C extends Config<any, any, any>, ref> = ref extends string
  ? C["chains"][ref]["source"]["kind"]
  : C["chains"][keyof ref & string]["source"]["kind"];

export type AccountEventOf<C extends Config<any, any, any>, K extends keyof AccountsOf<C>> =
  ChainKind<C, AccountsOf<C>[K]["chain"]> extends "bitcoin"
    ? BitcoinAccountEvent
    : ChainKind<C, AccountsOf<C>[K]["chain"]> extends "evm"
      ? EvmAccountEvent
      : EvmAccountEvent | BitcoinAccountEvent;

export type EventOf<C extends Config<any, any, any>, name extends string> = name extends "setup"
  ? SetupEvent
  : name extends `${infer K}:${infer E}`
    ? K extends keyof ContractsOf<C>
      ? ContractEvent<ContractsOf<C>[K]["abi"], E>
      : K extends keyof AccountsOf<C>
        ? AccountEventOf<C, K>
        : never
    : never;

export type ChainNames<C extends Config<any, any, any>> = keyof C["chains"] & string;

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
  if (type.startsWith("bytes") && type !== "bytes") return String(value).toLowerCase();
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
