# quickstart

USDC transfers on Base for wallets you register while it runs. Public RPC, no API keys.

```sh
docker run -d --name yail-clickhouse -p 127.0.0.1:18123:8123 -e CLICKHOUSE_PASSWORD=yail clickhouse/clickhouse-server:25.8
pnpm install && pnpm -r build     # repo root, once
cd examples/quickstart
pnpm migrate                      # creates the database and the `transfers` table
pnpm dev                          # http://localhost:42069/status
```

It starts at the chain head and fetches nothing until a wallet is registered. Add one that moves USDC (this one is busy):

```sh
curl -X POST localhost:42069/addresses -H 'content-type: application/json' \
  -d '{"set":"watched","address":"0x61040e143a77f165ba44543af4a079f2c809d14b"}'
```

The blocks since the start are backfilled by a job (`curl localhost:42069/jobs`), then the wallet is live. Query:

```sh
curl "http://default:yail@127.0.0.1:18123/" --data-binary \
  "SELECT direction, count(), sum(amount)/1e6 AS usdc FROM quickstart.transfers GROUP BY direction FORMAT PrettyCompact"
```

Re-index that wallet from scratch (rows deleted and rebuilt while the indexer keeps running):

```sh
pnpm yail reindex src/index.ts --chain base --scope wallet --value 0x61040e143a77f165ba44543af4a079f2c809d14b
```

Cleanup: `docker rm -f yail-clickhouse`.
