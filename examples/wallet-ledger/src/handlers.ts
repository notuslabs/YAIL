import type { BitcoinAccountEvent, ContractEvent, EvmAccountEvent, HandlerContext } from "@notuslabs/yail";
import type { erc20Abi } from "./abis.js";
import { ledger } from "./schema.js";

type Args<E> = { event: E; context: HandlerContext };

export async function onTransfer({ event, context }: Args<ContractEvent<typeof erc20Abi, "Transfer">>) {
  const { from, to, value } = event.args;
  const entry = { chain: context.chain.name, asset: event.address, kind: "token" as const, amount: value, txHash: event.log.transactionHash, logIndex: event.log.logIndex, blockNumber: BigInt(event.block.number), blockTime: new Date(event.block.timestamp * 1000) };
  if (context.addresses.has("wallets", from)) context.db.insert(ledger).values({ ...entry, wallet: from, direction: "out", counterparty: to });
  if (context.addresses.has("wallets", to)) context.db.insert(ledger).values({ ...entry, wallet: to, direction: "in", counterparty: from });
}

export async function onTransaction({ event, context }: Args<EvmAccountEvent>) {
  const tx = event.transaction;
  const entry = { chain: context.chain.name, asset: "native", wallet: event.address, txHash: tx.hash, blockNumber: BigInt(event.block.number), blockTime: new Date(event.block.timestamp * 1000) };
  let recipient = ""; // null for contract creations
  if (tx.to) recipient = tx.to;
  if (tx.value > 0n && tx.status !== 0) {
    if (event.direction !== "to") context.db.insert(ledger).values({ ...entry, kind: "native", direction: "out", amount: tx.value, counterparty: recipient, logIndex: -1 });
    if (event.direction !== "from") context.db.insert(ledger).values({ ...entry, kind: "native", direction: "in", amount: tx.value, counterparty: tx.from, logIndex: -1 });
  }
  if (event.direction !== "to" && tx.gasUsed !== undefined && tx.effectiveGasPrice !== undefined) {
    context.db.insert(ledger).values({ ...entry, kind: "fee", direction: "out", amount: tx.gasUsed * tx.effectiveGasPrice, counterparty: "", logIndex: -2 });
  }
}

export async function onBitcoinTransaction({ event, context }: Args<BitcoinAccountEvent>) {
  const entry = { chain: context.chain.name, asset: "btc", wallet: event.address, txHash: event.tx.txid, counterparty: "", blockNumber: BigInt(event.block.height), blockTime: new Date(event.block.time * 1000) };
  if (event.received > 0n) context.db.insert(ledger).values({ ...entry, kind: "btc", direction: "in", amount: event.received, logIndex: 0 });
  if (event.sent > 0n) context.db.insert(ledger).values({ ...entry, kind: "btc", direction: "out", amount: event.sent, logIndex: 1 });
  if (event.isSender) context.db.insert(ledger).values({ ...entry, kind: "fee", direction: "out", amount: event.fee, logIndex: 2 });
}
