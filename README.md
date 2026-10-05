# YAIL

Yet Another Indexer Library. A blockchain indexer with Ponder's developer experience, Envio HyperSync as the primary data source, and ClickHouse as the storage.

| path | what |
|---|---|
| [`packages/yail`](packages/yail/README.md) | the library: config, schema DSL, sources, runtime, CLI, testing helpers |
| [`examples/quickstart`](examples/quickstart/README.md) | five-minute try-out: one contract, one table, public RPC, no keys |
| [`examples/wallet-ledger`](examples/wallet-ledger/README.md) | multi-chain wallet ledger (Base, Polygon, Arbitrum, Bitcoin), the indexer behind the patrimony chart project |

```sh
pnpm install
pnpm -r build           # library -> packages/yail/dist
pnpm -r test            # needs Docker (ClickHouse testcontainer) or YAIL_TEST_CLICKHOUSE_URL
```

Tests replay recorded real chain data (`packages/yail/test/fixtures`) and assert against on-chain ground truth captured at record time. Refresh fixtures with `pnpm tsx packages/yail/scripts/record-fixtures.ts` (public RPCs, no keys needed).

Releasing: bump `version` in `packages/yail/package.json` and merge to `main`. CI publishes to npm (trusted publishing, with provenance) and creates the `v<version>` GitHub release when that version is not on the registry yet.
