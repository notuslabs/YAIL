import type { AbiEvent } from "viem";

/** Reference to a dynamic address set, persisted in ClickHouse and extensible at runtime. */
export interface AddressSetRef {
  readonly __brand: "yail.addressSet";
  readonly set: string;
}

/** Ponder-style factory: child addresses discovered from an event of a factory contract. */
export interface FactoryRef {
  readonly __brand: "yail.factory";
  readonly address: string | string[];
  readonly event: AbiEvent;
  readonly parameter: string;
}

/**
 * Refer to a dynamic address set. Addresses are registered at runtime
 * (`indexer.addresses.register`, `POST /addresses`, `yail addresses add`)
 * and backfilled from the contract's `startBlock` (or a per-address block).
 *
 * @example
 * contracts: { Erc20: { abi, chain: "base", filter: { event: "Transfer", args: { to: addressSet("wallets") } } } }
 */
export function addressSet(name: string): AddressSetRef {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Invalid address set name "${name}"`);
  return { __brand: "yail.addressSet", set: name };
}

export function factory(def: { address: string | string[]; event: AbiEvent; parameter: string }): FactoryRef {
  const names = def.event.inputs.map((i) => i.name);
  if (!names.includes(def.parameter)) {
    throw new Error(`factory(): event ${def.event.name} has no parameter "${def.parameter}" (has ${names.join(", ")})`);
  }
  return { __brand: "yail.factory", address: def.address, event: def.event, parameter: def.parameter };
}

export function isAddressSet(v: unknown): v is AddressSetRef {
  return typeof v === "object" && v !== null && (v as AddressSetRef).__brand === "yail.addressSet";
}
export function isFactory(v: unknown): v is FactoryRef {
  return typeof v === "object" && v !== null && (v as FactoryRef).__brand === "yail.factory";
}

/** Internal set name that stores discovered factory children for a contract/chain. */
export function factorySetName(contract: string): string {
  return `__factory:${contract}`;
}
