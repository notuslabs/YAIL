# wallet-ledger

The indexer behind the "patrimony chart" project: every movement of every registered wallet, on every chain, as a ledger in ClickHouse. Daily series and the "started with + deposits − withdrawals + result = ended with" summary are queries over it.

```
yail.config.ts   chains (Base, Polygon, Arbitrum via HyperSync; Bitcoin via Esplora), address sets, filters
src/schema.ts    ledger_entries, tokens, wallet_daily_flows (+ materialized view)
src/indexer.ts   handlers: ERC-20 transfers, native value + gas, Bitcoin UTXO movements, prices
src/queries.ts   balanceSeries(), balances(), flowsInPeriod() for an API
test/            replays recorded Base + Bitcoin data and checks against on-chain balances
```

## Run

```sh
export ENVIO_API_TOKEN=…            # https://app.envio.dev/api-tokens
export CLICKHOUSE_URL=http://default:@localhost:8123
pnpm migrate
pnpm yail addresses add --set wallets 0x…            # each becomes pending -> backfilled -> live
pnpm yail addresses add --set btcWallets bc1q…
LEDGER_PRICES=1 pnpm dev                              # prices from DefiLlama, cached in ClickHouse
```

Then, from any service with a ClickHouse client:

```ts
import { createDb } from "yail";
import { balanceSeries } from "wallet-ledger/src/queries";
const db = createDb({ url: process.env.CLICKHOUSE_URL, database: "wallet_ledger" });
const points = await balanceSeries(db, "0xabc…", { chain: "base" });
```

## Test

`pnpm test` starts a ClickHouse container (or uses `YAIL_TEST_CLICKHOUSE_URL`), replays 60 blocks of real Base USDC transfers for five wallets and the full history of three Bitcoin addresses, and asserts that the ledger's deltas equal the balance changes read from the chain.
