# yail

**Y**et **A**nother **I**ndexer **L**ibrary. Ponder-style developer experience, [HyperSync](https://docs.envio.dev/docs/HyperSync/overview) as the primary EVM data source, [ClickHouse](https://clickhouse.com) as the only storage.

```sh
pnpm add @notuslabs/yail          # Node >= 20, ESM
```

```ts
// yail.config.ts
import { createConfig, hypersync, esplora, addressSet } from "@notuslabs/yail";
import { erc20Abi } from "./abis";

export default createConfig({
  database: { url: "http://localhost:8123", database: "ledger" },
  chains: {
    base: { id: 8453, source: hypersync({ url: "https://base.hypersync.xyz" }), rpc: process.env.BASE_RPC_URL },
    bitcoin: { id: "bitcoin", source: esplora({ url: "https://mempool.space/api" }) },
  },
  contracts: {
    // Every ERC-20 on Base, but only transfers that touch a registered wallet.
    Erc20: { abi: erc20Abi, chain: "base", startBlock: 30_000_000,
      filter: [{ event: "Transfer", args: { from: addressSet("wallets") } }, { event: "Transfer", args: { to: addressSet("wallets") } }] },
  },
  accounts: {
    Wallets: { chain: "base", address: addressSet("wallets"), startBlock: 30_000_000 },
    BtcWallets: { chain: "bitcoin", address: addressSet("btcWallets"), startBlock: 800_000 },
  },
});
```

```ts
// src/index.ts
import { createIndexer } from "@notuslabs/yail";
import config from "../yail.config";
import * as schema from "./schema";

export const indexer = createIndexer({ config, schema });

indexer.on("Erc20:Transfer", async ({ event, context }) => {
  //                                   ^ event.args is typed from the ABI
  if (context.addresses.has("wallets", event.args.to)) {
    context.db.insert(schema.ledger).values({ wallet: event.args.to, token: event.address, amount: event.args.value, /* ... */ });
  }
});

indexer.on("BtcWallets:transaction", async ({ event }) => {
  event.received; event.sent; event.fee; // satoshis, typed because the chain is a Bitcoin source
});
```

```sh
yail migrate            # creates database, tables, materialized views
yail addresses add --set wallets 0xabc…   # queued, backfilled, then live
yail dev                # index, restart on change; status API on :42069
```

## Why

| | Ponder | HyperIndex (Envio) | yail |
|---|---|---|---|
| Handlers | `ponder.on("C:Event")` | `Contract.Event.handler` | `indexer.on("C:Event")` |
| Data source | JSON-RPC | HyperSync | HyperSync, JSON-RPC, Esplora (Bitcoin), or a cache in front of any |
| Storage | Postgres | Postgres | ClickHouse |
| Dynamic addresses | factory pattern | `contractRegister` | factory pattern **and** runtime address sets with backfill |
| Re-index one entity | re-sync | re-sync | `yail reindex --scope wallet=0x…` |
| Tests | — | mocks | replay recorded real data, assert against on-chain ground truth |

Everything the indexer writes is a plain ClickHouse table. An API reads it with the same `sql` tag and typed `db.rows()` the handlers use, or with any ClickHouse client.

## Concepts

### Sources

A source is one interface: `getHeight()` + `fetch(query)` yielding ordered batches of blocks, transactions and logs.

| source | use |
|---|---|
| `hypersync({ url, apiToken })` | production EVM. Token from `ENVIO_API_TOKEN` if omitted. |
| `rpc({ url })` | any JSON-RPC node; slower, no token, used to record fixtures |
| `esplora({ url })` | Bitcoin address history through mempool.space / blockstream / electrs |
| `cached(source, { db, chain })` | ClickHouse page cache in front of any source; `cache: { source: true }` in the config does this for every chain |
| `fixtureSource(fixture)` | replay recorded data in tests |

The runtime only ever indexes blocks `<= head - finality` (default 20 blocks on EVM, 3 on Bitcoin), so reorgs are a non-issue in practice. HyperSync's rollback guard is still checked; on a mismatch the last window is re-indexed automatically.

### Schema

```ts
import { t, table, materializedView, sql } from "@notuslabs/yail";

export const ledger = table("ledger", {
  chain: t.string().lowCardinality(),
  wallet: t.address(),          // lowercase 0x string
  amount: t.int256(),           // bigint in TS
  blockTime: t.dateTime(),      // Date in TS
  note: t.string().nullable(),
}, {
  orderBy: ["wallet", "chain", "txHash", "logIndex"], // primary key; duplicates collapse (ReplacingMergeTree)
  partitionBy: "toYYYYMM(block_time)",
  scopes: { wallet: "wallet" },                        // enables `reindex --scope wallet=…`
});

export const daily = table("wallet_daily", { wallet: t.address(), day: t.date(), net: t.int256() },
  { orderBy: ["wallet", "day"], engine: "SummingMergeTree", indexMeta: false });

export const dailyMv = materializedView("wallet_daily_mv", {
  from: ledger, to: daily,
  query: sql`SELECT wallet, toDate(block_time) AS day, sum(amount) AS net FROM ${ledger} GROUP BY wallet, day`,
});
```

- Column names are snake_cased in ClickHouse (`blockTime` → `block_time`), keys stay camelCase in TypeScript.
- Every table gets three hidden columns (`_yail_chain`, `_yail_block`, `_yail_version`). They make re-indexing and versioned dedup work. Opt out with `indexMeta: false` for aggregate targets.
- Default engine is `ReplacingMergeTree(_yail_version)`: re-inserting a row with the same key (re-run, backfill overlap, crash replay) never double counts. Read with `FINAL` (`db.rows()` does) or let merges settle.
- Materialized views are first class: created by `yail migrate`, backfilled over existing data with `yail migrate --populate`.
  They sum rows as they are inserted, before dedup, so a re-insert (replay, re-index) counts twice.
- Plain views (``view("balances", sql`SELECT … FROM ${ledger} FINAL …`)``) hold no data: they run on every read, so they
  always agree with their tables. `yail migrate` creates or replaces them, each after the views it reads.

### Handlers

```ts
indexer.on("Pool:Swap", async ({ event, context }) => {
  event.args        // typed from the ABI
  event.log, event.block, event.address, event.transaction /* with includeTransactions: true */
  context.chain     // { name, id, kind }
  context.db        // insert (buffered), find (buffer-aware), rows, query, command
  context.client    // viem readContract with a ClickHouse cache keyed by block (needs `rpc` on the chain)
  context.http      // fetch with optional ClickHouse cache: http.get(url, { cache: true })
  context.addresses // has/register/list for address sets
  context.log       // evlog wide event of the current batch: log.set({ ... })
});
indexer.on("Wallets:transaction", ...) // EVM: { transaction, block, address, direction, logs, traces }
                                      // Bitcoin: { tx, block, address, received, sent, net, fee, isSender }
indexer.on("setup", ...)              // once per chain before indexing starts
```

Writes are buffered per source batch and flushed as one INSERT per table before the checkpoint is written. Events are processed in `(block, txIndex, logIndex)` order per chain; chains run concurrently. Only events with a registered handler are fetched from the source.

`context.db.find(table, key)` looks at the current batch's buffer first, then ClickHouse. It is fine for last-value state (a pool's current tick), but the ClickHouse way is to write immutable facts and let `SummingMergeTree`/`AggregatingMergeTree` materialized views maintain aggregates.

### Wallet activity

An account normally matches the transactions an address sends or receives. With `activity: true` it matches every
transaction that mentions the address: in any indexed log topic (token transfers, user operations, approvals…) or as the
sender or recipient of a call trace. The event then carries the whole transaction: `event.logs` (all of its logs) and
`event.traces` (all of its call frames), one event per transaction and address.

```ts
accounts: { Wallets: { chain: "base", address: addressSet("wallets"), activity: true } },
```

Traces come only from trace-enabled HyperSync endpoints (e.g. `https://eth-traces.hypersync.xyz`,
`https://base-traces.hypersync.xyz`, a paid add-on); elsewhere `event.traces` is empty. Needs HyperSync (`rpc()` refuses
whole-transaction queries).

### Dynamic addresses and backfill

`addressSet("wallets")` can be used as a contract's `address`, in an event `filter`, or as an account's `address`. Members live in `_yail_addresses` and can be added at any time:

```ts
await indexer.addresses.register({ set: "wallets", address: "0xabc…", fromBlock: 30_000_000 });
```
```sh
yail addresses add --set wallets 0xabc… 0xdef…
curl -X POST :42069/addresses -d '{"set":"wallets","address":["0xabc…"]}'
```

What happens: the live loop adopts the address at its current block `N` and includes it from then on; a job backfills `[fromBlock, N)` with a query restricted to that address; the address flips to `live`. No gaps, no double processing. Progress is visible on `/status` and `/jobs`. Handlers see `context.backfill === true` during the backfill.

`factory({ address, event, parameter })` (Ponder style) discovers child contracts from a factory event; children found inside a batch have their logs fetched for the rest of that batch, so ordering is exact.

### Re-indexing

```sh
yail reindex --chain base --scope wallet --value 0xabc…      # delete rows where wallet = … in every table declaring that scope, re-run the address history
yail reindex --chain base --from 30000000 --to 30001000       # delete rows by _yail_block range, re-run the range
```
Both go through the same durable job queue (`_yail_jobs`), also reachable via `POST /reindex` and `indexer.reindex()`.

### Caching

- `cache.source` (or wrapping a source in `cached()`): raw source pages stored in `_yail_source_cache`, keyed by query shape. Re-runs with the same filters never hit HyperSync again. Off by default: HyperSync is fast. The key includes the address-set membership at query time, so a set that keeps growing produces new keys; the cache pays off for static filters and for re-running the same state (dev loops, handler fixes).
- `cache.http` (default on): `context.http.get(url, { cache: true | ttlMs })` persists responses in `_yail_http_cache`. Historical prices and swap classification stay deterministic across re-indexes.
- `cache.rpc` (default on): `context.client.readContract` results keyed by `(chain, block, to, calldata)` in `_yail_rpc_cache`.

### Observability

Logs are [evlog](https://www.evlog.dev) wide events: one per batch (chain, block range, events, rows, timings) and one per job, plus structured errors with `why`/`fix`. Metrics and traces use the OpenTelemetry API:

| metric | alert on |
|---|---|
| `yail.chain.lag_blocks` (gauge, per chain) | growing lag = source or handler problem |
| `yail.chain.caught_up` | 0 for longer than expected |
| `yail.errors` (counter, by stage) | any increase |
| `yail.jobs` (counter, by outcome) | `outcome=failed` |
| `yail.batch.duration`, `yail.handler.duration`, `yail.flush.duration` | latency histograms |
| `yail.cache.events` | hit/miss by cache |

Export everything with one call:

```ts
import { startTelemetry } from "@notuslabs/yail/otel";
startTelemetry({ serviceName: "wallet-ledger", endpoint: "http://otel-collector:4318" }); // traces + metrics over OTLP/HTTP
```
Set `observability.otlpEndpoint` (or `OTEL_EXPORTER_OTLP_ENDPOINT`) to ship logs over OTLP too, and `observability.logsToClickHouse: true` to keep them in `_yail_logs` next to your data (zero extra infrastructure). Recent events are always available at `GET /_evlog/logs`.

HTTP status API (`server.port`, default 42069): `/health`, `/ready` (caught up on every chain), `/status`, `/addresses`, `/reindex`, `/jobs`.

### Testing with real data

```ts
import { startTestClickHouse, fixtureSource, readFixture } from "@notuslabs/yail/testing";

const ch = await startTestClickHouse();               // YAIL_TEST_CLICKHOUSE_URL or a testcontainer
const fixture = readFixture("test/fixtures/base-univ3-weth-usdc.json");
const config = createConfig({ database: ch.database(), chains: { base: { id: 8453, source: fixtureSource(fixture), finality: 0 } }, contracts: { … } });
const indexer = createIndexer({ config, schema });
indexer.on("Pool:Swap", …);
await indexer.run();                                   // index to the fixture height, drain jobs, stop
expect((await indexer.db.find(poolState, { pool }))!.liquidity).toBe(fixture.expected.liquidity);
```

Fixtures are recorded from a real chain (`yail record --chain base --from … --to … --out fixture.json`, or `recordEvmFixture` in a script) and can carry `expected` ground truth read at the same block. `packages/yail/test/real-data.test.ts` checks a Uniswap V3 pool's price and liquidity against `slot0()`, USDC wallet deltas against `balanceOf()`, and Bitcoin address totals against Esplora stats.

## CLI

```
yail start [entry]       run (entry exports the indexer; default src/index.ts)
yail dev [entry]         run, restart on changes
yail migrate [entry]     --populate | --reset
yail reindex [entry]     --chain … (--from … --to … | --scope … --value …)
yail addresses add|list  --set … [--chain …] [--from-block …]
yail record [entry]      --chain … --from … --to … --out …
yail status              --url http://localhost:42069
```

## Limits and notes

- Bitcoin is scanned per address through Esplora (HyperSync has no Bitcoin, Bitcoin Core has no address index). Fine for wallet sets in the thousands; for more, point `esplora({ url })` at your own electrs.
- Internal ETH transfers are only visible through traces, which HyperSync serves on a few chains as a paid add-on (see Wallet activity).
- ClickHouse has no transactions: a crash between a table flush and the checkpoint is repaired by the ReplacingMergeTree key on the next run, so give every table a real identity key.
- Cross-chain ordering is not enforced (chains are independent loops).
