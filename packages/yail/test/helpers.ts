import { encodeAbiParameters, keccak256, toHex } from "viem";
import type { EvmBlock, EvmFixture, EvmLog, EvmTrace, EvmTransaction } from "../src/sources/index.js";
import { padAddress } from "../src/indexer/events.js";

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const POOL_CREATED_TOPIC = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";

export function addr(n: number): string {
  return `0x${n.toString(16).padStart(40, "0")}`;
}

function blockHash(n: number): string {
  return keccak256(toHex(n));
}

function parentHashOf(n: number): string {
  if (n === 0) return `0x${"0".repeat(64)}`;
  return blockHash(n - 1);
}

export class FixtureBuilder {
  blocks: EvmBlock[] = [];
  transactions: EvmTransaction[] = [];
  logs: EvmLog[] = [];
  traces: EvmTrace[] = [];
  private logIndexByBlock = new Map<number, number>();
  private txIndexByBlock = new Map<number, number>();

  constructor(public readonly height: number, from = 0) {
    for (let n = from; n <= height; n++) this.blocks.push({ number: n, hash: blockHash(n), parentHash: parentHashOf(n), timestamp: 1_700_000_000 + n * 2 });
  }

  private nextLogIndex(block: number): number {
    const i = this.logIndexByBlock.get(block) ?? 0;
    this.logIndexByBlock.set(block, i + 1);
    return i;
  }

  tx(block: number, from: string, to: string | null, value: bigint, extra: Partial<EvmTransaction> = {}): EvmTransaction {
    const idx = this.txIndexByBlock.get(block) ?? 0;
    this.txIndexByBlock.set(block, idx + 1);
    const tx: EvmTransaction = { hash: keccak256(toHex(`${block}:${idx}`)), blockNumber: block, transactionIndex: idx, from: from.toLowerCase(), to: to?.toLowerCase() ?? null, value, input: "0x", gasUsed: 21_000n, effectiveGasPrice: 1_000_000_000n, status: 1, ...extra };
    this.transactions.push(tx);
    return tx;
  }

  transfer(block: number, token: string, from: string, to: string, value: bigint, tx?: EvmTransaction): EvmLog {
    const t = tx ?? this.tx(block, from, token, 0n);
    const log: EvmLog = {
      blockNumber: block,
      blockHash: this.blocks.find((b) => b.number === block)!.hash,
      transactionHash: t.hash,
      transactionIndex: t.transactionIndex,
      logIndex: this.nextLogIndex(block),
      address: token.toLowerCase(),
      data: encodeAbiParameters([{ type: "uint256" }], [value]),
      topics: [TRANSFER_TOPIC, padAddress(from), padAddress(to)],
    };
    this.logs.push(log);
    return log;
  }

  /** A call frame of `tx` (the root frame is `traceAddress: []`). */
  trace(tx: EvmTransaction, from: string, to: string, value: bigint, traceAddress: number[]): EvmTrace {
    const trace: EvmTrace = { transactionHash: tx.hash, blockNumber: tx.blockNumber, traceAddress, type: "call", callType: "call", from: from.toLowerCase(), to: to.toLowerCase(), value };
    this.traces.push(trace);
    return trace;
  }

  poolCreated(block: number, factory: string, token0: string, token1: string, fee: number, pool: string): EvmLog {
    const t = this.tx(block, addr(0xdead), factory, 0n);
    const log: EvmLog = {
      blockNumber: block,
      blockHash: this.blocks.find((b) => b.number === block)!.hash,
      transactionHash: t.hash,
      transactionIndex: t.transactionIndex,
      logIndex: this.nextLogIndex(block),
      address: factory.toLowerCase(),
      data: encodeAbiParameters([{ type: "int24" }, { type: "address" }], [60, pool as `0x${string}`]),
      topics: [POOL_CREATED_TOPIC, padAddress(token0), padAddress(token1), encodeAbiParameters([{ type: "uint24" }], [fee])],
    };
    this.logs.push(log);
    return log;
  }

  build(name = "synthetic"): EvmFixture {
    return { version: 1, kind: "evm", name, chainId: 1337, height: this.height, fromBlock: this.blocks[0]!.number, toBlock: this.height + 1, blocks: this.blocks, transactions: this.transactions, logs: this.logs, traces: this.traces };
  }
}
