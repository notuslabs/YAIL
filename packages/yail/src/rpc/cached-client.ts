import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, type Abi, type ContractFunctionArgs, type ContractFunctionName, type PublicClient } from "viem";
import type { Db } from "../db/client.js";
import { rpcCache } from "../db/internal.js";
import { sql } from "../db/sql.js";

export interface ReadContractParams<abi extends Abi, fn extends ContractFunctionName<abi, "pure" | "view">> {
  address: string;
  abi: abi;
  functionName: fn;
  args?: ContractFunctionArgs<abi, "pure" | "view", fn>;
  /** Block to read at. Defaults to the block of the event being processed. */
  blockNumber?: number | bigint;
  /** Bypass the cache for this call. */
  noCache?: boolean;
}

export interface CachedClient {
  /** Underlying viem client for anything else. */
  readonly raw: PublicClient;
  /** `eth_call` cached by (chain, block, to, calldata) in ClickHouse. Typed like viem's readContract. */
  readContract<abi extends Abi, fn extends ContractFunctionName<abi, "pure" | "view">>(
    params: ReadContractParams<abi, fn>,
  ): Promise<ReturnType<typeof decodeFunctionResult<abi, fn>>>;
  /** Contract reads with the same block/cache semantics, run in parallel. */
  multicall<T extends ReadonlyArray<ReadContractParams<any, any>>>(calls: T): Promise<{ [K in keyof T]: unknown }>;
}

export interface CachedClientOptions {
  chain: string;
  url: string;
  db?: Db;
  persist?: boolean;
  onCache?: (hit: boolean) => void;
  /** Provided by the runtime: the block currently being processed. */
  currentBlock?: () => number | undefined;
}

export function createCachedClient(options: CachedClientOptions): CachedClient {
  const raw = createPublicClient({ transport: http(options.url, { batch: true, retryCount: 4 }) });
  const persist = options.persist !== false && options.db !== undefined;
  const memory = new Map<string, string>();

  async function readContract(params: ReadContractParams<any, any>): Promise<any> {
    const data = encodeFunctionData({ abi: params.abi, functionName: params.functionName, args: params.args as any });
    const blockNumber = params.blockNumber ?? options.currentBlock?.();
    const to = params.address.toLowerCase();
    let block: number | undefined;
    if (blockNumber !== undefined) block = Number(blockNumber);
    let key: string | undefined;
    if (block !== undefined) key = `${block}:${to}:${data}`;
    let result: string | undefined;
    if (key && !params.noCache) {
      result = memory.get(key);
      if (result === undefined && persist) {
        const rows = await options.db!.query<{ result: string }>(
          sql`SELECT result FROM ${rpcCache} FINAL WHERE chain = ${options.chain} AND block = ${block!} AND to = ${to} AND data = ${data} LIMIT 1`,
        );
        result = rows[0]?.result;
        if (result !== undefined) memory.set(key, result);
      }
      options.onCache?.(result !== undefined);
    }
    if (result === undefined) {
      let blockTag: bigint | undefined;
      if (block !== undefined) blockTag = BigInt(block);
      const res = await raw.call({ to: to as `0x${string}`, data, blockNumber: blockTag });
      result = res.data ?? "0x";
      if (key && !params.noCache) {
        memory.set(key, result);
        if (persist) {
          await options.db!.insert(rpcCache).values({ chain: options.chain, block: BigInt(block!), to, data, result, createdAt: new Date() });
        }
      }
    }
    return decodeFunctionResult({ abi: params.abi, functionName: params.functionName, data: result as `0x${string}` });
  }

  return {
    raw,
    readContract: readContract as CachedClient["readContract"],
    multicall: (calls) => Promise.all(calls.map((c) => readContract(c))) as any,
  };
}
