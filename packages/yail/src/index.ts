// Config
export { createConfig, addressSet, factory } from "./config/index.js";
export type { Config, ChainConfig, ContractConfig, AccountConfig, EventFilter, AddressSpec, AddressSetRef, FactoryRef, CacheConfig, ObservabilityConfig, ServerConfig, IndexingConfig, AddressSetConfig } from "./config/index.js";

// Schema + database
export { t, table, materializedView, view, tableDdl, materializedViewDdl, viewDdl } from "./schema/index.js";
export type { Table, TableOptions, TableEngine, Column, InsertRow, InferRow, MaterializedView, Refresh, View } from "./schema/index.js";
export { createDb, sql, migrate, schemaDdl, BatchWriter, internalTables } from "./db/index.js";
export type { Db, DatabaseConfig, SqlFragment, MigrateOptions } from "./db/index.js";

// Sources
export { hypersync, rpc, cached, esplora, fixtureSource } from "./sources/index.js";
export type { Source, EvmSource, BitcoinSource, EvmQuery, EvmBatch, EvmLog, EvmBlock, EvmTransaction, EvmTrace, EvmTraceFilter, BitcoinQuery, BitcoinBatch, BitcoinTransaction, HypersyncOptions, RpcSourceOptions, EsploraOptions, CachedSourceOptions } from "./sources/index.js";

// Indexer
export { createIndexer } from "./indexer/indexer.js";
export { cache } from "./cache/cached.js";
export type { Cached, CacheContext, CacheStore } from "./cache/cached.js";
export { memory, redis } from "./cache/stores.js";
export type { Indexer, IndexerOptions, StatusSnapshot, ReindexRequest } from "./indexer/indexer.js";
export type { HandlerContext, HandlerDb, AddressesApi } from "./indexer/context.js";
export type { ContractEvent, EvmAccountEvent, BitcoinAccountEvent, SetupEvent, EventNames, EventOf } from "./indexer/events.js";
export type { HttpClient, HttpResponse, HttpRequestInit, HttpCacheOptions } from "./http/client.js";
export type { CachedClient, ReadContractParams } from "./rpc/cached-client.js";
export type { AddressRow, AddressStatus } from "./addresses/registry.js";

// Observability
export { createError } from "./observability/logger.js";
export type { Observability, WideLogger } from "./observability/logger.js";
export { createApp } from "./server/api.js";

// Handy re-exports
export { parseAbi, parseAbiItem, formatUnits, parseUnits, getAddress, isAddress } from "viem";
export type { Abi, AbiEvent } from "viem";
