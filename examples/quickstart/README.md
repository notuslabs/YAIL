# quickstart

The smallest useful yail indexer: every USDC transfer on Base from "now", plus a watch-list of wallets you add at runtime. Public RPC, no API keys. Takes about five minutes.

## 1. ClickHouse

```sh
docker run -d --name yail-clickhouse -p 127.0.0.1:18123:8123 -e CLICKHOUSE_PASSWORD=yail clickhouse/clickhouse-server:25.8
curl "http://default:yail@127.0.0.1:18123/?query=SELECT%20version()"
```

## 2. Build and migrate

```sh
pnpm install && pnpm -r build          # from the repo root, once
cd examples/quickstart
pnpm migrate                           # creates database `quickstart`, tables, the materialized view
```

## 3. Run

```sh
pnpm dev                               # or pnpm start; restarts on file changes
```

You will see one line per batch (chain, block range, events, timings) and `base: caught up at block …` within a few seconds. The status API is on http://localhost:42069:

```sh
curl localhost:42069/status | jq .chains.base     # cursor, head, lagBlocks, eventsProcessed, errors
curl localhost:42069/ready                        # 200 once every chain is caught up
```

## 4. Watch a wallet (dynamic address + backfill)

Pick any address that moves USDC on Base (block explorer, or `0x61040e143a77f165ba44543af4a079f2c809d14b`, a busy one):

```sh
curl -X POST localhost:42069/addresses -H 'content-type: application/json' \
  -d '{"set":"watched","address":"0x61040e143a77f165ba44543af4a079f2c809d14b"}'
# or: pnpm yail addresses add src/index.ts --set watched 0x61040e…
curl localhost:42069/jobs           # backfill_address … done
curl localhost:42069/addresses      # status: pending -> backfilling -> live
```

The live loop adopts the address at its current block; a job backfills the blocks between the contract's start and that block (`backfilled = true` rows); from then on the address is part of the live query.

## 5. Query

```sh
CH() { curl -s "http://default:yail@127.0.0.1:18123/" --data-binary "$1"; }
CH "SELECT count(), min(block_number), max(block_number) FROM quickstart.usdc_transfers FORMAT PrettyCompact"
CH "SELECT minute, transfers, volume/1e6 AS usdc FROM quickstart.usdc_minute_volume ORDER BY minute DESC LIMIT 5 FORMAT PrettyCompact"
CH "SELECT direction, backfilled, count(), sum(amount)/1e6 AS usdc FROM quickstart.watched_transfers GROUP BY direction, backfilled FORMAT PrettyCompact"
```

Or from code, with the same schema the indexer uses:

```ts
import { createDb, sql } from "yail";
import { watched } from "./src/schema";
const db = createDb({ url: "http://default:yail@localhost:18123", database: "quickstart" });
const rows = await db.rows(watched, sql`WHERE wallet = ${"0x6104…"} ORDER BY block_number DESC LIMIT 20`);
```

## 6. Break something and re-index it

```sh
CH "INSERT INTO quickstart.watched_transfers (wallet, direction, tx_hash, log_index, counterparty, amount, block_number, block_time, backfilled, _yail_chain, _yail_block)
    VALUES ('0x61040e143a77f165ba44543af4a079f2c809d14b','in','0xbogus',0,'0x0',999999000000,1,now(),false,'base',1)"
pnpm yail reindex src/index.ts --chain base --scope wallet --value 0x61040e143a77f165ba44543af4a079f2c809d14b
```

The running indexer picks the job up within ten seconds, deletes that wallet's rows in every table that declares `scopes: { wallet }`, and rebuilds them from the source. `--from/--to` re-indexes a block range the same way.

## 7. Look at the logs and metrics

- `curl localhost:42069/_evlog/logs?limit=20` returns the last wide events (one per batch and per job).
- Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` and add `import { startTelemetry } from "yail/otel"; startTelemetry();` at the top of `src/index.ts` to ship `yail.chain.lag_blocks`, `yail.errors`, batch/handler histograms and traces to any OTLP collector (Grafana, Datadog, Honeycomb, HyperDX).

## Next

- Replace `rpc(...)` with `hypersync({ url: "https://base.hypersync.xyz" })` and set `ENVIO_API_TOKEN` for historical ranges (set a numeric `startBlock`; the RPC source is only meant for the tip and for recording test fixtures).
- Look at `examples/wallet-ledger` for the multi-chain + Bitcoin version with tests against recorded real data.

Cleanup: `docker rm -f yail-clickhouse`.
