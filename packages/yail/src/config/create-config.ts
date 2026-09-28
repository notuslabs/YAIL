import type { AccountConfig, ChainConfig, Config, ContractConfig } from "./types.js";
import { isAddressSet, isFactory } from "./address.js";
import { chainNames } from "./chain-ref.js";
import { toArray } from "../util.js";

/**
 * Define the indexer configuration. Returns the object unchanged; the
 * generics preserve literal types so `indexer.on("Contract:Event")` and
 * `event.args` are fully typed.
 */
export function createConfig<
  const chains extends Record<string, ChainConfig>,
  const contracts extends Record<string, ContractConfig<any>> = {},
  const accounts extends Record<string, AccountConfig> = {},
>(config: Config<chains, contracts, accounts>): Config<chains, contracts, accounts> {
  validateConfig(config);
  return config;
}

export function validateConfig(config: Config<any, any, any>): void {
  if (!config.database?.url) throw new Error("config.database.url is required");
  const configuredChains = Object.keys(config.chains ?? {});
  if (configuredChains.length === 0) throw new Error("config.chains must define at least one chain");
  for (const [name, chain] of Object.entries(config.chains) as Array<[string, ChainConfig]>) {
    if (!chain.source) throw new Error(`chain "${name}": source is required`);
    if (chain.id === undefined) throw new Error(`chain "${name}": id is required`);
  }
  const sets = new Set(Object.keys(config.addressSets ?? {}));
  const checkChainRef = (owner: string, ref: string | Record<string, unknown>) => {
    for (const n of chainNames(ref)) if (!config.chains[n]) throw new Error(`${owner}: unknown chain "${n}"`);
  };
  const checkAddress = (owner: string, spec: unknown) => {
    if (spec === undefined) return;
    if (isAddressSet(spec)) {
      sets.add(spec.set);
      return;
    }
    if (isFactory(spec)) return;
    for (const a of toArray<unknown>(spec)) {
      if (typeof a !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`${owner}: invalid EVM address "${String(a)}"`);
    }
  };
  for (const [name, c] of Object.entries((config.contracts ?? {}) as Record<string, ContractConfig>)) {
    if (!c.abi) throw new Error(`contract "${name}": abi is required`);
    checkChainRef(`contract "${name}"`, c.chain as any);
    checkAddress(`contract "${name}"`, c.address);
    if (typeof c.chain !== "string") for (const [cn, o] of Object.entries(c.chain)) checkAddress(`contract "${name}" on ${cn}`, o.address);
    const filters = toArray(c.filter ?? []);
    for (const f of filters) {
      const ev = c.abi.find((x: any) => x.type === "event" && x.name === f.event);
      if (!ev) throw new Error(`contract "${name}": filter references unknown event "${f.event}"`);
      for (const arg of Object.keys(f.args ?? {})) {
        const input = (ev as any).inputs.find((i: any) => i.name === arg);
        if (!input) throw new Error(`contract "${name}": filter for ${f.event} references unknown argument "${arg}"`);
        if (!input.indexed) throw new Error(`contract "${name}": filter argument "${arg}" of ${f.event} must be indexed`);
        const v = (f.args as any)[arg];
        if (isAddressSet(v)) sets.add(v.set);
      }
    }
  }
  for (const [name, a] of Object.entries((config.accounts ?? {}) as Record<string, AccountConfig>)) {
    checkChainRef(`account "${name}"`, a.chain as any);
    if (a.address === undefined) throw new Error(`account "${name}": address is required`);
    if (isFactory(a.address)) throw new Error(`account "${name}": factory() is not supported for accounts`);
    if (!isAddressSet(a.address)) {
      const evm = chainNames(a.chain).every((cn) => config.chains[cn].source.kind === "evm");
      if (evm) checkAddress(`account "${name}"`, a.address);
    }
  }
  config.addressSets = { ...(config.addressSets ?? {}) };
  for (const s of sets) config.addressSets[s] ??= {};
}
