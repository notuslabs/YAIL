import { describe, expectTypeOf, it } from "vitest";
import { createConfig, addressSet } from "../src/config/index.js";
import { createIndexer } from "../src/indexer/indexer.js";
import { fixtureSource } from "../src/sources/fixture.js";
import type { BitcoinAccountEvent, EvmAccountEvent, EventOf, SolanaAccountEvent } from "../src/indexer/events.js";

const evm = fixtureSource({ version: 1, kind: "evm", height: 0, fromBlock: 0, toBlock: 0, blocks: [], transactions: [], logs: [] });
const bitcoin = fixtureSource({ version: 1, kind: "bitcoin", height: 0, fromBlock: 0, toBlock: 0, transactions: [] });
const solana = fixtureSource({ version: 1, kind: "solana", height: 0, fromBlock: 0, toBlock: 0, blocks: [], transactions: [], balances: [] });

// The shapes of a config built at runtime: an EVM map from a list of names, and chains present only when selected.
const selected = ["polygon", "base"];
const perChain = <T>(f: (name: string) => T) => Object.fromEntries(selected.map((name) => [name, f(name)]));
const onBitcoin = <T>(scoped: T): { bitcoin?: T } => ({ bitcoin: scoped });
const onSolana = <T>(scoped: T): { solana?: T } => ({ solana: scoped });

const database = { url: "http://localhost:8123" };
const accounts = {
  Wallets: { chain: perChain(() => ({ startBlock: 0 })), address: addressSet("wallets") },
  BtcWallets: { chain: onBitcoin({ startBlock: 0 }), address: addressSet("bitcoinWallets") },
  SolanaWallets: { chain: onSolana({ startBlock: 0 }), address: addressSet("solanaWallets") },
};

describe("account event types", () => {
  it("types an optional chain key by its chain (Object.assign)", () => {
    const config = createConfig({
      database,
      chains: Object.assign(
        perChain((name) => ({ id: name, source: evm })),
        onBitcoin({ id: "bitcoin", source: bitcoin }),
        onSolana({ id: "solana", source: solana }),
      ),
      accounts,
    });
    expectTypeOf<EventOf<typeof config, "Wallets:transaction">>().toEqualTypeOf<EvmAccountEvent>();
    expectTypeOf<EventOf<typeof config, "BtcWallets:transaction">>().toEqualTypeOf<BitcoinAccountEvent>();
    expectTypeOf<EventOf<typeof config, "SolanaWallets:transaction">>().toEqualTypeOf<SolanaAccountEvent>();
  });

  it("types a chains spread by chain, the runtime-built map as EVM", () => {
    const config = createConfig({
      database,
      chains: { ...perChain((name) => ({ id: name, source: evm })), ...onBitcoin({ id: "bitcoin", source: bitcoin }), ...onSolana({ id: "solana", source: solana }) },
      accounts,
    });
    const indexer = createIndexer({ config, schema: {} });
    indexer.on("Wallets:transaction", ({ event, context }) => {
      expectTypeOf(event).toEqualTypeOf<EvmAccountEvent>();
      expectTypeOf(event.transaction.hash).toEqualTypeOf<string>();
      expectTypeOf(context.chain.name).toEqualTypeOf<string>();
    });
    indexer.on("BtcWallets:transaction", ({ event }) => {
      expectTypeOf(event).toEqualTypeOf<BitcoinAccountEvent>();
    });
    indexer.on("SolanaWallets:transaction", ({ event }) => {
      expectTypeOf(event).toEqualTypeOf<SolanaAccountEvent>();
    });
  });

  it("types a spread of literal-keyed optional chains by chain", () => {
    const evmChains: { polygon?: { id: number; source: typeof evm }; base?: { id: number; source: typeof evm } } = { polygon: { id: 137, source: evm }, base: { id: 8453, source: evm } };
    const config = createConfig({
      database,
      chains: { ...evmChains, ...onSolana({ id: "solana", source: solana }) },
      accounts: {
        Wallets: { chain: { polygon: {}, base: {} }, address: addressSet("wallets") },
        SolanaWallets: { chain: onSolana({}), address: addressSet("solanaWallets") },
      },
    });
    expectTypeOf<EventOf<typeof config, "Wallets:transaction">>().toEqualTypeOf<EvmAccountEvent>();
    expectTypeOf<EventOf<typeof config, "SolanaWallets:transaction">>().toEqualTypeOf<SolanaAccountEvent>();
  });

  it("types a non-EVM map built at runtime by its kind when merged with Object.assign", () => {
    const solanaChains = Object.fromEntries(["solana"].map((name) => [name, { id: name, source: solana }]));
    const config = createConfig({
      database,
      chains: Object.assign(solanaChains, onBitcoin({ id: "bitcoin", source: bitcoin })),
      accounts: { SolanaWallets: { chain: "solana", address: addressSet("solanaWallets") }, BtcWallets: { chain: "bitcoin", address: addressSet("bitcoinWallets") } },
    });
    expectTypeOf<EventOf<typeof config, "SolanaWallets:transaction">>().toEqualTypeOf<SolanaAccountEvent>();
    expectTypeOf<EventOf<typeof config, "BtcWallets:transaction">>().toEqualTypeOf<BitcoinAccountEvent>();
  });

  it("keeps a literal config's chain names", () => {
    const config = createConfig({
      database,
      chains: { base: { id: 8453, source: evm }, bitcoin: { id: "bitcoin", source: bitcoin } },
      accounts: { Wallets: { chain: "base", address: addressSet("wallets") }, BtcWallets: { chain: { bitcoin: {} }, address: addressSet("bitcoinWallets") } },
    });
    const indexer = createIndexer({ config, schema: {} });
    indexer.on("Wallets:transaction", ({ event, context }) => {
      expectTypeOf(event).toEqualTypeOf<EvmAccountEvent>();
      expectTypeOf(context.chain.name).toEqualTypeOf<"base" | "bitcoin">();
    });
    indexer.on("BtcWallets:transaction", ({ event }) => {
      expectTypeOf(event).toEqualTypeOf<BitcoinAccountEvent>();
    });
  });
});
