# wallet-ledger

Every movement of every registered wallet, on Base, Polygon, Arbitrum and Bitcoin, as a ledger in ClickHouse. Daily balance curves and "deposits vs. result" summaries are queries over it.

```
yail.config.ts   chains, the ERC-20 filter on the `wallets` set, native + Bitcoin accounts
src/schema.ts    the ledger table
src/handlers.ts  three handlers: token transfer, native transaction (value + gas), Bitcoin transaction
src/queries.ts   balanceSeries() for an API
test/            replays recorded real data and checks it against on-chain balances
```

```sh
export ENVIO_API_TOKEN=…                       # https://app.envio.dev/api-tokens
export CLICKHOUSE_URL=http://default:yail@localhost:18123
pnpm migrate
pnpm dev
pnpm yail addresses add src/index.ts --set wallets 0x…       # backfilled from each chain's start block, then live
pnpm yail addresses add src/index.ts --set btcWallets bc1q…
pnpm test                                       # Docker (ClickHouse container) or YAIL_TEST_CLICKHOUSE_URL
```

From any service: `createDb({ url, database: "wallet_ledger" })` and `balanceSeries(db, wallet)`, or plain SQL over the `ledger` table.
