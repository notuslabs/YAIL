import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk/base";
import { addressSet, createConfig } from "../src/config/index.js";
import { internalTables } from "../src/db/index.js";
import { createIndexer } from "../src/indexer/indexer.js";
import { stellarAccountEvent, type EventOf, type StellarAccountEvent } from "../src/indexer/events.js";
import { galexie } from "../src/sources/galexie.js";
import type { StellarEvent, StellarTransaction } from "../src/sources/types.js";
import { startTestClickHouse, type TestClickHouse } from "../src/testing/index.js";
import { t, table } from "../src/schema/index.js";
import { sql } from "../src/db/sql.js";

// Ledger 65,012,084 (2026-10-18) of the AWS public lake: in it, WALLET sends AQUA and XTAR to a liquidity pool.
const LEDGER = 65_012_084;
const WALLET = "GAD7OHE7KLZVEN5HT4NXP64I6LJ2QUO5FU5KIM4644VNDLB62QICTI4O";
const HASH = "d111a57cdc0a2c99f7be8ff7dcb0577e594e62b159ab091f157e8caa2a7630af";
const AQUA = "AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA";
const XTAR = "XTAR:GAORYJ3KBDGIM7FFSKVUJHJ5NEFWIRDIAGGBJBJS7TY6ECZS53257IG4";
const file = readFileSync(new URL("./fixtures/stellar-ledger-65012084.xdr.zst", import.meta.url));
// Ledger 63,717,881 (2026-07-30): a smart wallet signs with address v2 credentials, which @stellar/stellar-base 15 could not read.
const v2File = readFileSync(new URL("./fixtures/stellar-ledger-63717881.xdr.zst", import.meta.url));
const lake = "https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/pubnet";

/** Serves the fixture for every ledger file: a ledger outside the range asked for is skipped by its sequence. */
function fakeLake(paths: string[] = [], head = LEDGER, ledgerFile = file): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname + url.search);
    if (url.pathname.endsWith("/.config.json")) return new Response(JSON.stringify({ compression: "zstd", ledgersPerBatch: 1, batchesPerPartition: 64000 }));
    if (url.searchParams.get("delimiter")) return new Response("<ListBucketResult><Contents><Key>v1.1/stellar/ledgers/pubnet/.config.json</Key></Contents><CommonPrefixes><Prefix>v1.1/stellar/ledgers/pubnet/FC20C9FF--64960000-65023999/</Prefix></CommonPrefixes></ListBucketResult>");
    const key = `${(0xffffffff - head).toString(16).toUpperCase()}--${head}.xdr.zst`;
    if (url.searchParams.get("list-type")) return new Response(`<ListBucketResult><Contents><Key>v1.1/stellar/ledgers/pubnet/FC20C9FF--64960000-65023999/${key}</Key></Contents></ListBucketResult>`);
    if (url.pathname.endsWith(".xdr.zst")) return new Response(ledgerFile);
    return new Response("missing", { status: 404 });
  };
}

describe("galexie()", () => {
  it("reads the head from the newest partition's newest file", async () => {
    const paths: string[] = [];
    expect(await galexie({ fetch: fakeLake(paths) }).getHeight()).toBe(LEDGER);
    expect(paths).toHaveLength(2);
  });

  it("returns the transactions whose events name an address, with every event and the ledger", async () => {
    const batches = [];
    for await (const batch of galexie({ fetch: fakeLake() }).fetch({ fromBlock: LEDGER, toBlock: LEDGER + 1, addresses: [WALLET] })) batches.push(batch);
    expect(batches).toHaveLength(1);
    const [batch] = batches;
    expect(batch!.ledgers).toEqual([{ sequence: LEDGER, closeTime: 1_792_346_202, hash: expect.stringMatching(/^a660beb910fba4e7/) }]);
    expect(batch!.transactions).toEqual([{ hash: HASH, ledger: LEDGER, transactionIndex: expect.any(Number), feeSource: expect.stringMatching(/^G/), feeCharged: 200n, success: true }]);
    expect(batch!.events.map((e) => [e.operationIndex, e.topics[0]])).toEqual([
      [null, "fee"],
      [0, "transfer"],
      [0, "transfer"],
    ]);
    const event = stellarAccountEvent(batch!.transactions[0]!, batch!.ledgers[0]!, batch!.events, WALLET);
    expect(event?.deltas).toEqual([
      { asset: AQUA, amount: -8_918_416n },
      { asset: XTAR, amount: -555_860_401n },
    ]);
  });

  it("reads transactions signed with address v2 credentials", async () => {
    const wallet = "CDZMQ6W6JNRPLHBRL3WZPDJPUCMWIJANSOI6WY7ISAOMVOHYRQSMRBLV";
    const batches = [];
    for await (const batch of galexie({ fetch: fakeLake([], LEDGER, v2File) }).fetch({ fromBlock: 63_717_881, toBlock: 63_717_882, addresses: [wallet] })) batches.push(batch);
    const [batch] = batches;
    expect(batch!.transactions.map((tx) => tx.hash)).toEqual(["fb6756a261bedd6a9ccebbc28d3f2b3797331071fa7fde582880ef0b8533dc70"]);
    expect(stellarAccountEvent(batch!.transactions[0]!, batch!.ledgers[0]!, batch!.events, wallet)?.deltas).toEqual([{ asset: "USDM0:GDM5QWWXCMDTQMZAKMYTCI52LA7FWBHAZMU5NJLMIFHDJISJRP2ZWPKC", amount: -50_000_000n }]);
  });

  it("skips a ledger without the raw key of any address, and yields its range empty", async () => {
    const batches = [];
    for await (const batch of galexie({ fetch: fakeLake() }).fetch({ fromBlock: LEDGER, toBlock: LEDGER + 1, addresses: ["GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H"] })) batches.push(batch);
    expect(batches).toEqual([{ fromBlock: LEDGER, nextBlock: LEDGER + 1, ledgers: [], transactions: [], events: [] }]);
  });
});

describe("stellarAccountEvent", () => {
  const tx: StellarTransaction = { hash: "h", ledger: 1, transactionIndex: 0, feeSource: WALLET, feeCharged: 100n, success: true };
  const ledger = { sequence: 1, closeTime: 0, hash: "l" };
  const SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
  const TOKEN = "CBG4QGCVAAMHJYQJ4RSOOANUWVL72DA4XEXTUQSNKSXRJVKMHIVEAPEP";
  const OTHER = "GCV23IMOW6GWFK476LLCZADD4EXELNCH7XRFBWOQXIGHKXUFHL74F5ZR";
  const ADMIN = "GCCLGWNRLCE4ZV75YZ355GLXN7K4DOVXPKWZRI4O2FNJTZZ5JLLO5KTO";
  const event = (contract: string, topics: unknown[], data: unknown, eventIndex = 0): StellarEvent => ({ transactionHash: "h", ledger: 1, transactionIndex: 0, operationIndex: 0, eventIndex, contract, topics, data });

  it("nets the fee charged and refunded, transfers both ways, and mints, burns and clawbacks old and new", () => {
    const events = [
      event(SAC, ["fee", WALLET], 1_000n),
      event(SAC, ["transfer", WALLET, OTHER, "native"], 50n),
      event(SAC, ["transfer", OTHER, WALLET, "native"], { amount: 20n, to_muxed_id: 7n }),
      event(TOKEN, ["mint", WALLET], 5n),
      event(TOKEN, ["mint", ADMIN, WALLET], 3n),
      event(TOKEN, ["burn", WALLET], 2n),
      event(TOKEN, ["clawback", ADMIN, WALLET], 1n),
      event(SAC, ["transfer", OTHER, ADMIN, "native"], 9n),
      event(SAC, ["fee", WALLET], -400n),
    ];
    expect(stellarAccountEvent(tx, ledger, events, WALLET)?.deltas).toEqual([
      { asset: "native", amount: -1_000n + 400n - 50n + 20n },
      { asset: TOKEN, amount: 5n },
    ]);
  });

  it("is null for a transaction none of whose events names the address", () => {
    expect(stellarAccountEvent(tx, ledger, [event(SAC, ["transfer", OTHER, ADMIN, "native"], 9n)], WALLET)).toBeNull();
  });
});

describe("stellar end to end", () => {
  let ch: TestClickHouse;
  beforeAll(async () => {
    ch = await startTestClickHouse();
  });
  afterAll(async () => {
    await ch.stop();
  });

  function stellarConfig() {
    return createConfig({
      database: ch.database(),
      chains: { stellar: { id: "stellar", source: galexie({ fetch: fakeLake() }) } },
      accounts: { Wallets: { chain: { stellar: { startBlock: LEDGER } }, address: [WALLET] } },
      server: { port: false },
      observability: { pretty: false },
    });
  }

  it("types account events on a Stellar chain", () => {
    expectTypeOf<EventOf<ReturnType<typeof stellarConfig>, "Wallets:transaction">>().toEqualTypeOf<StellarAccountEvent>();
  });

  it("delivers the wallet's transaction with its deltas to the account handler", async () => {
    const deltas = table("deltas", { hash: t.string(), asset: t.string(), amount: t.int256() }, { orderBy: ["hash", "asset"] });
    const indexer = createIndexer({ config: stellarConfig(), schema: { deltas } });
    indexer.on("Wallets:transaction", ({ event, context }) => {
      for (const { asset, amount } of event.deltas) context.db.insert(deltas).values({ hash: event.transaction.hash, asset, amount });
    });
    await indexer.run();
    const rows = await indexer.db.query<{ hash: string; asset: string; amount: string }>(sql`SELECT hash, asset, toString(amount) AS amount FROM ${deltas} FINAL ORDER BY asset`);
    await indexer.db.close();
    expect(rows).toEqual([
      { hash: HASH, asset: AQUA, amount: "-8918416" },
      { hash: HASH, asset: XTAR, amount: "-555860401" },
    ]);
  });

  it("backfills wallets registered together in one job, however many", async () => {
    const database = ch.database();
    const deltas = table("deltas", { hash: t.string(), asset: t.string(), amount: t.int256() }, { orderBy: ["hash", "asset"] });
    const indexerAt = (head: number) => {
      const config = createConfig({
        database,
        chains: { stellar: { id: "stellar", source: galexie({ fetch: fakeLake([], head) }) } },
        accounts: { Wallets: { chain: { stellar: { startBlock: LEDGER } }, address: addressSet("wallets") } },
        server: { port: false },
        observability: { pretty: false },
      });
      const indexer = createIndexer({ config, schema: { deltas } });
      indexer.on("Wallets:transaction", ({ event, context }) => {
        for (const { asset, amount } of event.deltas) context.db.insert(deltas).values({ hash: event.transaction.hash, asset, amount });
      });
      return indexer;
    };
    const caughtUp = indexerAt(LEDGER);
    await caughtUp.run();
    await caughtUp.db.close();
    const indexer = indexerAt(LEDGER + 1);
    await indexer.init();
    const others = Array.from({ length: 600 }, () => Keypair.random().publicKey());
    await indexer.addresses.register([WALLET, ...others].map((address) => ({ set: "wallets", address })));
    await indexer.run();
    const jobs = await indexer.db.rows(internalTables.jobs);
    const rows = await indexer.db.query<{ asset: string }>(sql`SELECT asset FROM ${deltas} FINAL ORDER BY asset`);
    await indexer.db.close();
    expect(jobs.map((j) => [j.status, (j.payload.addresses as string[]).length])).toEqual([["done", 601]]);
    expect(rows.map((r) => r.asset)).toEqual([AQUA, XTAR]);
  });
});
