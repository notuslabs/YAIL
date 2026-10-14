import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { EMIT_CPI_TAG, Reader, anchorDiscriminator, anchorEvent, anchorInstruction, b, base58Decode, base58Encode, decode, instruction, programData, programLog, type Codec } from "../src/solana/index.js";
import { createConfig } from "../src/config/index.js";
import type { Config } from "../src/config/types.js";
import { buildPlans, buildSolanaQuery } from "../src/indexer/plan.js";
import { createIndexer } from "../src/indexer/indexer.js";
import type { HandlerContext } from "../src/indexer/context.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { AddressRegistry } from "../src/addresses/registry.js";
import { cached } from "../src/sources/cached.js";
import { fixtureSource, type SolanaFixture } from "../src/sources/fixture.js";
import type { SolanaBalance, SolanaInstruction, SolanaLog, SolanaQuery, SolanaTransaction } from "../src/sources/types.js";
import { startTestClickHouse, type TestClickHouse } from "../src/testing/index.js";
import { t, table } from "../src/schema/index.js";
import { sql } from "../src/db/sql.js";

const AMM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const PUMP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const WALLET = "8dVSpuXXqZmvsTJbTTut7acjhxUmknABHR6RhSkPNawV";
const POOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const bytes = (...values: number[]) => Uint8Array.from(values);
const le = (n: bigint, size: number) => Uint8Array.from({ length: size }, (_, i) => Number((n >> BigInt(8 * i)) & 255n));
const hex = (...parts: Array<string | Uint8Array>) => parts.map((p) => (typeof p === "string" ? p : Buffer.from(p).toString("hex"))).join("");

const ammSwap = b.struct({ amountIn: b.u64, minimumAmountOut: b.u64 });
const clmmSwapEvent = b.struct({ pool: b.pubkey, amount: b.u64 });

function programsConfig(source = fixtureSource({ version: 1, kind: "solana", height: 1000, fromBlock: 0, toBlock: 1001, blocks: [], transactions: [], balances: [] })) {
  return createConfig({
    database: { url: "http://localhost:8123" },
    chains: { solana: { id: "solana", source, finality: 0 } },
    accounts: { Wallets: { chain: "solana", address: [WALLET] } },
    programs: {
      Clmm: {
        chain: "solana",
        address: CLMM,
        includeBalances: true,
        instructions: { swap: anchorInstruction("swap", { args: b.struct({ amount: b.u64 }), accounts: ["payer", "config", "pool"] }) },
        events: { SwapEvent: anchorEvent("SwapEvent", clmmSwapEvent), PoolCreatedEvent: anchorEvent("PoolCreatedEvent", b.struct({ pool: b.pubkey })) },
      },
      Amm: {
        chain: { solana: { startBlock: 5 } },
        address: AMM,
        includeLogs: true,
        instructions: { swapBaseIn: instruction({ discriminator: "09", args: ammSwap }), swapV2: anchorInstruction("swap_v2", { args: ammSwap }), deposit: instruction({ discriminator: "03" }) },
      },
      Pump: { chain: "solana", address: PUMP, emit: "cpi", events: { BuyEvent: anchorEvent("BuyEvent", b.struct({ baseAmountOut: b.u64 })) } },
      Off: { chain: {}, address: PUMP, emit: "cpi", events: { SellEvent: anchorEvent("SellEvent", b.struct({ baseAmountIn: b.u64 })) } },
    },
    server: { port: false },
    observability: { pretty: false },
  });
}

describe("solana codec", () => {
  it("reads integers at their boundaries, negative ones included", () => {
    expect(decode(b.u64, le(2n ** 64n - 1n, 8))).toBe(2n ** 64n - 1n);
    expect(decode(b.u64, le(0n, 8))).toBe(0n);
    expect(decode(b.u128, le(2n ** 128n - 1n, 16))).toBe(2n ** 128n - 1n);
    expect(decode(b.u128, le(2n ** 64n, 16))).toBe(2n ** 64n);
    expect(decode(b.i32, bytes(0xff, 0xff, 0xff, 0xff))).toBe(-1);
    expect(decode(b.i32, bytes(0, 0, 0, 0x80))).toBe(-(2 ** 31));
    expect(decode(b.i64, le(2n ** 64n - 2n, 8))).toBe(-2n);
    expect(decode(b.i128, le(2n ** 128n - 1n, 16))).toBe(-1n);
    expect(decode(b.u16, bytes(0x34, 0x12))).toBe(0x1234);
    expect(decode(b.u32, bytes(1, 0, 0, 1))).toBe(2 ** 24 + 1);
    expect(decode(b.bool, bytes(1))).toBe(true);
  });

  it("encodes and decodes base58", () => {
    const token = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    expect(base58Encode(new TextEncoder().encode("Hello World!"))).toBe("2NEpo7TZRRrLZSi2U");
    expect(Buffer.from(base58Decode(token)).toString("hex")).toBe("06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9");
    expect(decode(b.pubkey, base58Decode(token))).toBe(token);
    expect(base58Encode(new Uint8Array(32))).toBe("11111111111111111111111111111111");
    expect(Buffer.from(base58Decode("112")).toString("hex")).toBe("000001");
    expect(() => base58Decode("0OIl")).toThrow(/invalid character/);
  });

  it("reads options, vectors, strings and structs in order", () => {
    const codec = b.struct({ some: b.option(b.u8), none: b.option(b.u8), list: b.vec(b.u16), name: b.string, pair: b.array(b.u8, 2), tag: b.bytes(2) });
    const data = bytes(1, 7, 0, 2, 0, 0, 0, 1, 0, 2, 0, 3, 0, 0, 0, 0x61, 0x62, 0x63, 9, 8, 0xab, 0xcd);
    expect(decode(codec, data)).toEqual({ some: 7, none: null, list: [1, 2], name: "abc", pair: [9, 8], tag: "abcd" });
  });

  it("ignores trailing bytes and throws on a short buffer", () => {
    expect(decode(b.struct({ x: b.u8 }), bytes(5, 6, 7))).toEqual({ x: 5 });
    expect(() => decode(b.u64, bytes(1, 2, 3))).toThrow(RangeError);
    expect(() => decode(b.struct({ x: b.u8, y: b.u32 }), bytes(1, 2))).toThrow(RangeError);
  });

  it("reads fields that only some eras have with remaining(), and keeps the rest as hex", () => {
    const head = b.struct({ x: b.u8 });
    const versioned: Codec<{ x: number; y: number | null }> = { read: (reader) => ({ ...head.read(reader), y: reader.remaining() >= 2 ? b.u16.read(reader) : null }) };
    expect(decode(versioned, bytes(1))).toEqual({ x: 1, y: null });
    expect(decode(versioned, bytes(1, 2, 0, 9))).toEqual({ x: 1, y: 2 });
    expect(decode(b.struct({ x: b.u8, rest: b.rest }), bytes(1, 0xde, 0xad))).toEqual({ x: 1, rest: "dead" });
    expect(decode(b.struct({ x: b.u8, rest: b.rest }), bytes(1))).toEqual({ x: 1, rest: "" });
    const reader = new Reader(bytes(1, 2, 3));
    reader.take(1);
    expect(reader.remaining()).toBe(2);
  });
});

describe("solana program definitions", () => {
  it("computes Anchor discriminators", () => {
    expect(anchorDiscriminator("event", "SwapEvent")).toBe("40c6cde8260871e2");
    expect(anchorDiscriminator("global", "swap")).toBe("f8c69e91e17587c8");
    expect(anchorEvent("SwapEvent", b.struct({})).discriminator).toBe("40c6cde8260871e2");
    expect(anchorInstruction("swap_v2").discriminator).toBe("2b04ed0b1ac91e62");
    expect(instruction({ discriminator: "09" })).toMatchObject({ kind: "instruction", discriminator: "09", accounts: [] });
  });

  it("reads Program data lines with or without their prefix", () => {
    expect(Buffer.from(programData("Program data: QMbN6CYIceI=")).toString("hex")).toBe("40c6cde8260871e2");
    expect(Buffer.from(programData("QMbN6CYIceI=")).toString("hex")).toBe("40c6cde8260871e2");
    expect(programLog("Program log: ray_log: CQ==")).toBe("ray_log: CQ==");
    expect(programLog("ray_log: CQ==")).toBe("ray_log: CQ==");
  });

  it("rejects programs on other chains, bad ids, bad discriminators and clashing names", () => {
    const evm = fixtureSource({ version: 1, kind: "evm", height: 1, fromBlock: 0, toBlock: 1, blocks: [], transactions: [], logs: [] });
    const solana = fixtureSource({ version: 1, kind: "solana", height: 1, fromBlock: 0, toBlock: 1, blocks: [], transactions: [], balances: [] });
    const chains = { base: { id: 8453, source: evm }, solana: { id: "solana", source: solana } };
    const program = { address: AMM, instructions: { swap: instruction({ discriminator: "09" }) } };
    const onBase = createConfig({ database: { url: "http://x" }, chains, programs: { P: { ...program, chain: "base" } } });
    expect(() => buildPlans(onBase, { handled: new Set(["P:swap"]), resolveLatest: () => 0 })).toThrow(/chain "base" is not a Solana chain/);
    expect(() => createConfig({ database: { url: "http://x" }, chains, programs: { P: { ...program, chain: "nope" } } })).toThrow(/unknown chain "nope"/);
    expect(() => createConfig({ database: { url: "http://x" }, chains, programs: { P: { ...program, chain: "solana", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } } })).toThrow(/invalid program id/);
    expect(() => createConfig({ database: { url: "http://x" }, chains, programs: { P: { chain: "solana", address: AMM, instructions: { swap: instruction({ discriminator: "0x09" }) } } } })).toThrow(/discriminator "0x09"/);
    expect(() => createConfig({ database: { url: "http://x" }, chains, programs: { P: { chain: "solana", address: AMM, instructions: { swap: instruction({ discriminator: "090909" }) } } } })).toThrow(/1, 2, 4 or 8 bytes/);
    expect(() => createConfig({ database: { url: "http://x" }, chains, programs: { P: { chain: "solana", address: AMM, instructions: { Swap: instruction({ discriminator: "09" }) }, events: { Swap: anchorEvent("Swap", b.struct({})) } } } })).toThrow(/both an instruction and an event/);
    expect(() => createConfig({ database: { url: "http://x" }, chains: { base: chains.base }, programs: { P: { ...program, chain: {} } } })).not.toThrow();
    expect(() => createConfig({ database: { url: "http://x" }, chains: { base: chains.base }, programs: { P: { ...program, chain: { solana: {} } } } })).toThrow(/unknown chain "solana"/);
  });
});

describe("buildSolanaQuery", () => {
  const registry = new AddressRegistry({} as Db, (_chain, address) => address);
  const handled = new Set(["Wallets:transaction", "Clmm:SwapEvent", "Amm:swapBaseIn", "Amm:swapV2", "Pump:BuyEvent", "Off:SellEvent"]);
  const plan = buildPlans(programsConfig(), { handled, resolveLatest: () => 1000 }).get("solana")!;

  it("asks only for handled definitions, each program from its start", () => {
    expect(plan.programs.map((p) => p.name)).toEqual(["Clmm", "Amm", "Pump"]);
    expect(buildSolanaQuery(plan, 10, 20, registry)).toEqual({
      fromBlock: 10,
      toBlock: 20,
      addresses: [WALLET],
      instructions: [
        { programs: [AMM], discriminators: ["2b04ed0b1ac91e62", "09"], logKinds: ["log", "data"], balances: false },
        { programs: [PUMP], discriminators: [EMIT_CPI_TAG], isInner: true, logKinds: [], balances: false },
      ],
      logs: [{ programs: [CLMM], kinds: ["data"], balances: true }],
    });
    expect(buildSolanaQuery(plan, 0, 5, registry).instructions.map((f) => f.programs)).toEqual([[PUMP]]);
  });

  it("skips programs in address backfills", () => {
    expect(buildSolanaQuery(plan, 10, 20, registry, { override: { set: "wallets", addresses: [WALLET] } })).toMatchObject({ instructions: [], logs: [] });
  });

  it("plans nothing for a program on chain {} or on a chain the config does not have", () => {
    expect(plan.programs.some((p) => p.name === "Off")).toBe(false);
    const noChains: Config = { ...programsConfig(), chains: {} };
    expect(buildPlans(noChains, { handled, resolveLatest: () => 1000 }).size).toBe(0);
  });
});

describe("solana program event types", () => {
  it("types each handler from its definition, on a chain {} program too", () => {
    const indexer = createIndexer({ config: programsConfig(), schema: {} });
    indexer.on("Clmm:SwapEvent", ({ event }) => {
      expectTypeOf(event.data).toEqualTypeOf<{ pool: string; amount: bigint }>();
      expectTypeOf(event.address).toEqualTypeOf<number[] | null>();
    });
    indexer.on("Clmm:swap", ({ event }) => {
      expectTypeOf(event.args.amount).toEqualTypeOf<bigint>();
      expectTypeOf(event.accounts.pool).toEqualTypeOf<string>();
      // @ts-expect-error not one of the definition's account names
      void event.accounts.vault;
    });
    indexer.on("Amm:swapBaseIn", ({ event }) => {
      expectTypeOf(event.args).toEqualTypeOf<{ amountIn: bigint; minimumAmountOut: bigint }>();
      expectTypeOf(event.programLogs).toEqualTypeOf<SolanaLog[]>();
      expectTypeOf(event.ordinal).toEqualTypeOf<number>();
    });
    indexer.on("Amm:deposit", ({ event }) => {
      expectTypeOf(event.args).toEqualTypeOf<Record<string, never>>();
    });
    indexer.on("Off:SellEvent", ({ event }) => {
      expectTypeOf(event.data.baseAmountIn).toEqualTypeOf<bigint>();
    });
    // @ts-expect-error not a definition of the program
    indexer.on("Amm:SwapEvent", () => {});
  });
});

describe("solana programs end to end", () => {
  let ch: TestClickHouse;
  const dbs: Db[] = [];
  beforeAll(async () => {
    ch = await startTestClickHouse();
  });
  afterAll(async () => {
    for (const db of dbs) await db.close();
  });

  const tx = (signature: string, slot: number, transactionIndex: number, success = true): SolanaTransaction => ({ signature, slot, transactionIndex, feePayer: WALLET, fee: 5000n, success });
  const ix = (signature: string, slot: number, transactionIndex: number, address: number[], program: string, data: string, accounts: string[] = []): SolanaInstruction => ({ signature, slot, transactionIndex, address, program, accounts, data, isInner: address.length > 1 });
  const log = (signature: string, slot: number, transactionIndex: number, instructionAddress: number[] | null, program: string, kind: "log" | "data", message: string): SolanaLog => ({ signature, slot, transactionIndex, instructionAddress, program, kind, message });
  const swapEvent = (amount: bigint) => Buffer.from(hex(anchorDiscriminator("event", "SwapEvent"), base58Decode(POOL), le(amount, 8)), "hex").toString("base64");
  const ammData = (amountIn: bigint) => hex("09", le(amountIn, 8), le(1n, 8));
  const vault: SolanaBalance = { signature: "A", slot: 10, transactionIndex: 3, account: "Vault111111111111111111111111111111111111111", token: { mint: POOL, owner: CLMM, decimals: 6, pre: 1n, post: 2n } };

  const fixture: SolanaFixture = {
    version: 1,
    kind: "solana",
    name: "synthetic-programs",
    height: 20,
    fromBlock: 0,
    toBlock: 21,
    blocks: [
      { slot: 10, time: 1_000 },
      { slot: 11, time: 1_001 },
    ],
    transactions: [tx("A", 10, 3), tx("B", 10, 4, false), tx("C", 11, 0)],
    balances: [{ signature: "A", slot: 10, transactionIndex: 3, account: WALLET, lamports: { pre: 10_000n, post: 5_000n } }],
    instructions: [
      ix("A", 10, 3, [0], CLMM, hex(anchorDiscriminator("global", "swap"), le(5n, 8)), ["Payer11111111111111111111111111111111111111", "Config1111111111111111111111111111111111111", POOL]),
      ix("A", 10, 3, [1], AMM, ammData(100n)),
      ix("A", 10, 3, [1, 0], PUMP, hex(EMIT_CPI_TAG, anchorDiscriminator("event", "BuyEvent"), le(7n, 8))),
      ix("A", 10, 3, [1, 1], PUMP, hex(EMIT_CPI_TAG, anchorDiscriminator("event", "SellEvent"), le(8n, 8))),
      ix("B", 10, 4, [0], AMM, ammData(999n)),
      ix("C", 11, 0, [3], AMM, ammData(300n)),
      ix("C", 11, 0, [1], AMM, ammData(200n)),
      ix("C", 11, 0, [2], CLMM, hex(anchorDiscriminator("global", "swap"), le(6n, 8)), ["Payer11111111111111111111111111111111111111"]),
    ],
    logs: [
      log("A", 10, 3, [0], CLMM, "data", swapEvent(5n)),
      log("A", 10, 3, [1], AMM, "log", "ray_log: AA=="),
      log("B", 10, 4, [0], AMM, "log", "ray_log: BB=="),
      log("C", 11, 0, null, AMM, "log", "ray_log: first"),
      log("C", 11, 0, null, CLMM, "data", swapEvent(6n)),
      log("C", 11, 0, null, AMM, "log", "ray_log: second"),
      log("C", 11, 0, null, CLMM, "data", Buffer.from(hex(anchorDiscriminator("event", "LiquidityChangeEvent"), le(1n, 8)), "hex").toString("base64")),
      log("C", 11, 0, null, CLMM, "data", Buffer.from(hex(anchorDiscriminator("event", "SwapEvent"), "00"), "hex").toString("base64")),
    ],
    joinedBalances: [vault],
  };

  it("delivers instructions and events of successful transactions in address order, after the wallet's event", async () => {
    const calls = table("calls", { signature: t.string(), handler: t.string(), detail: t.string() }, { orderBy: ["signature", "handler", "detail"] });
    const config = programsConfig(fixtureSource(fixture));
    const indexer = createIndexer({ config: { ...config, database: ch.database() }, schema: { calls } });
    const seen: string[] = [];
    const record = (context: HandlerContext, signature: string, handler: string, detail: unknown) => {
      const row = { signature, handler, detail: JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) };
      seen.push(`${signature} ${handler} ${row.detail}`);
      context.db.insert(calls).values(row);
    };
    indexer.on("Wallets:transaction", ({ event, context }) => record(context, event.transaction.signature, "wallet", event.lamports));
    indexer.on("Clmm:swap", ({ event, context }) => record(context, event.transaction.signature, "Clmm:swap", { pool: event.accounts.pool, amount: event.args.amount, balances: event.balances.map((x) => x.account) }));
    indexer.on("Clmm:SwapEvent", ({ event, context }) => record(context, event.transaction.signature, "Clmm:SwapEvent", { address: event.address, amount: event.data.amount, pool: event.data.pool }));
    indexer.on("Amm:swapBaseIn", ({ event, context }) => {
      const detail = { address: event.address, ordinal: event.ordinal, amountIn: event.args.amountIn, siblings: event.programInstructions.map((i) => i.address), logs: event.programLogs.map((l) => l.message) };
      record(context, event.transaction.signature, "Amm:swapBaseIn", detail);
    });
    indexer.on("Pump:BuyEvent", ({ event, context }) => record(context, event.transaction.signature, "Pump:BuyEvent", { address: event.address, out: event.data.baseAmountOut }));
    indexer.on("Off:SellEvent", () => {
      throw new Error("a chain {} program must not run");
    });
    await indexer.run();
    dbs.push(indexer.db);

    expect(seen).toEqual([
      'A wallet "-5000"',
      'A Clmm:swap {"pool":"' + POOL + '","amount":"5","balances":["' + vault.account + '"]}',
      'A Clmm:SwapEvent {"address":[0],"amount":"5","pool":"' + POOL + '"}',
      'A Amm:swapBaseIn {"address":[1],"ordinal":0,"amountIn":"100","siblings":[[1]],"logs":["ray_log: AA=="]}',
      'A Pump:BuyEvent {"address":[1],"out":"7"}',
      'C Clmm:SwapEvent {"address":null,"amount":"6","pool":"' + POOL + '"}',
      'C Amm:swapBaseIn {"address":[1],"ordinal":0,"amountIn":"200","siblings":[[1],[3]],"logs":["ray_log: first","ray_log: second"]}',
      'C Amm:swapBaseIn {"address":[3],"ordinal":1,"amountIn":"300","siblings":[[1],[3]],"logs":["ray_log: first","ray_log: second"]}',
    ]);
    const versions = await indexer.db.query<{ handler: string; version: string }>(sql`SELECT handler, toString(_yail_version) AS version FROM ${calls} WHERE signature = 'A' ORDER BY _yail_version`);
    const base = (10n << 32n) + 3n * 65536n;
    expect(versions).toEqual(["wallet", "Clmm:swap", "Clmm:SwapEvent", "Amm:swapBaseIn", "Pump:BuyEvent"].map((handler, rank) => ({ handler, version: String(base + BigInt(rank)) })));
  });

  it("serves a shorter range of a cached batch with only its rows", async () => {
    const db = createDb(ch.database());
    await migrate(db, {});
    dbs.push(db);
    const inner = fixtureSource(fixture, { blocksPerBatch: 21 });
    const source = cached(inner, { db, chain: "solana" });
    const query: SolanaQuery = { fromBlock: 0, toBlock: 21, addresses: [WALLET], instructions: [{ programs: [AMM], discriminators: ["09"], logKinds: ["log"], balances: false }], logs: [{ programs: [CLMM], kinds: ["data"], balances: true }] };
    for await (const _ of source.fetch(query)) continue;
    const read = async (from: typeof inner) => {
      const out = [];
      for await (const batch of from.fetch({ ...query, toBlock: 11 })) out.push(batch);
      return out;
    };
    const [batch] = await read(source);
    expect(batch).toEqual((await read(inner))[0]);
    expect(batch!.instructions.map((i) => i.signature)).toEqual(["A"]);
    expect(batch!.logs.map((l) => l.signature)).toEqual(["A", "A"]);
    expect(batch!.joinedBalances).toEqual([vault]);
  });
});
