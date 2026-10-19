import * as zlib from "node:zlib";
import { StrKey, scValToNative, xdr } from "@stellar/stellar-sdk/base";
import type { FetchOptions, StellarBatch, StellarEvent, StellarQuery, StellarSource } from "./types.js";
import { append, counted, request, requestBytes, requestListeners } from "../util.js";

export interface GalexieOptions {
  /** Root of a Galexie data lake on S3 (the folder holding `.config.json`). Default: the AWS public dataset, pubnet. */
  url?: string;
  /** Ledger files downloaded at once. Default 64. */
  concurrency?: number;
  /** Ledgers per yielded batch. Default 2,000 (~3 hours). */
  batchLedgers?: number;
  /** Override fetch (testing). */
  fetch?: typeof fetch;
}

interface LakeConfig {
  ledgersPerBatch: number;
  batchesPerPartition: number;
  compression: string;
}

const awsPubnet = "https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/pubnet";
const succeeded = new Set(["txSuccess", "txFeeBumpInnerSuccess"]);

/**
 * Stellar source backed by a Galexie data lake: one zstd XDR `LedgerCloseMetaBatch` per file, from genesis to a few
 * seconds behind the network (the AWS public dataset). The lake has no address index, so every query reads its
 * ledgers whole. A ledger is decoded only when the raw 32-byte key of one of the addresses is in its bytes (XDR keeps
 * keys 4-byte aligned), so a scan costs a download and a decompression per ledger. Transactions match through their
 * CAP-67 events (transfer, mint, burn, clawback, fee), which the lake carries for all of history.
 */
export function galexie(options: GalexieOptions = {}): StellarSource {
  if (typeof zlib.zstdDecompress !== "function") throw new Error(`galexie() needs zstd in node:zlib (Node 22.15 or later), this is Node ${process.version}`);
  const listeners = requestListeners();
  const doFetch = counted(options.fetch ?? fetch, listeners.count);
  const root = new URL((options.url ?? awsPubnet).replace(/\/$/, ""));
  const concurrency = options.concurrency ?? 64;
  const batchLedgers = options.batchLedgers ?? 2_000;
  let lake: Promise<LakeConfig> | undefined;

  async function config(): Promise<LakeConfig> {
    lake ??= request(doFetch, `${root}/.config.json`).then((text) => {
      const parsed = JSON.parse(text) as LakeConfig;
      if (parsed.compression !== "zstd") throw new Error(`galexie(${root.host}): unsupported compression ${parsed.compression}`);
      return parsed;
    });
    return lake;
  }

  /** S3 keys under `prefix`, ascending: partitions and files are named by 0xFFFFFFFF minus their first ledger, so the newest comes first. */
  async function firstKey(prefix: string, delimiter: boolean): Promise<string | undefined> {
    const query = new URLSearchParams({ "list-type": "2", prefix, "max-keys": "2", ...(delimiter && { delimiter: "/" }) });
    const listing = await request(doFetch, `${root.origin}/?${query}`);
    const tag = delimiter ? /<Prefix>([^<]+\/)<\/Prefix>/g : /<Key>([^<]+)<\/Key>/g;
    return [...listing.matchAll(tag)].flatMap(([, key]) => (key ? [key] : [])).find((key) => key !== prefix && !key.endsWith(".config.json"));
  }

  function fileUrl({ ledgersPerBatch, batchesPerPartition }: LakeConfig, start: number): string {
    const partitionSize = ledgersPerBatch * batchesPerPartition;
    const partition = start - (start % partitionSize);
    const name = (first: number, last: number) => `${(0xffffffff - first).toString(16).toUpperCase().padStart(8, "0")}--${first}${last > first ? `-${last}` : ""}`;
    return `${root}/${name(partition, partition + partitionSize - 1)}/${name(start, start + ledgersPerBatch - 1)}.xdr.zst`;
  }

  return {
    kind: "stellar",
    name: `galexie(${root.host})`,
    async getHeight() {
      const prefix = `${root.pathname.slice(1)}/`;
      const partition = await firstKey(prefix, true);
      const file = partition && (await firstKey(partition, false));
      const [, first, last] = file?.match(/--(\d+)(?:-(\d+))?\.xdr/) ?? [];
      if (!first) throw new Error(`galexie(${root.host}): no ledger files under ${prefix}`);
      return Number(last ?? first);
    },
    async *fetch(query: StellarQuery, fetchOptions?: FetchOptions) {
      const signal = fetchOptions?.signal;
      const lakeConfig = await config();
      const { ledgersPerBatch } = lakeConfig;
      const mentions = keyScanner(query.addresses);
      const wanted = new Set(query.addresses);
      for (let from = query.fromBlock; from < query.toBlock; from += batchLedgers) {
        const next = Math.min(from + batchLedgers, query.toBlock);
        const batch: StellarBatch = { fromBlock: from, nextBlock: next, ledgers: [], transactions: [], events: [] };
        const starts: number[] = [];
        for (let start = from - (from % ledgersPerBatch); start < next; start += ledgersPerBatch) starts.push(start);
        for (let i = 0; i < starts.length; i += concurrency) {
          const files = await Promise.all(
            starts.slice(i, i + concurrency).map(async (start) => {
              const raw = await zstd(await requestBytes(doFetch, fileUrl(lakeConfig, start), { signal }));
              return mentions(raw) ? raw : null;
            }),
          );
          for (const raw of files) if (raw) readLedgers(raw, from, next, wanted, batch);
        }
        yield batch;
      }
    },
    onRequest: listeners.onRequest,
  };
}

function zstd(compressed: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => zlib.zstdDecompress(compressed, (err, out) => (err ? reject(err) : resolve(out))));
}

function rawKey(address: string): Buffer | null {
  if (StrKey.isValidEd25519PublicKey(address)) return StrKey.decodeEd25519PublicKey(address);
  if (StrKey.isValidContract(address)) return StrKey.decodeContract(address);
  if (StrKey.isValidLiquidityPool(address)) return StrKey.decodeLiquidityPool(address);
  return null;
}

/**
 * Whether a decompressed ledger file holds the raw key of one of the addresses. A 2^24-bit filter on each aligned
 * word's top 24 bits skips nearly every offset before the exact comparison. An address without a raw key (not a
 * strkey) matches every file.
 */
export function keyScanner(addresses: string[]): (raw: Buffer) => boolean {
  const keys = addresses.map(rawKey);
  if (keys.includes(null)) return () => true;
  const byWord = new Map<number, Buffer[]>();
  const bits = new Uint32Array(1 << 19);
  for (const key of keys as Buffer[]) {
    const word = key.readUInt32LE(0);
    const bit = word >>> 8;
    bits[bit >>> 5]! |= 1 << (bit & 31);
    byWord.set(word, [...(byWord.get(word) ?? []), key]);
  }
  return (raw) => {
    const aligned = raw.byteOffset % 4 === 0 ? raw : Buffer.from(raw);
    const words = new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.length >>> 2);
    for (let i = 0; i + 8 <= words.length; i++) {
      const word = words[i]!;
      const bit = word >>> 8;
      if ((bits[bit >>> 5]! & (1 << (bit & 31))) === 0) continue;
      if (byWord.get(word)?.some((key) => aligned.compare(key, 0, 32, i * 4, i * 4 + 32) === 0)) return true;
    }
    return false;
  };
}

/** Appends the ledgers of a file within [from, next) and their transactions with an event naming one of `wanted`. */
function readLedgers(raw: Buffer, from: number, next: number, wanted: Set<string>, batch: StellarBatch): void {
  for (const meta of xdr.LedgerCloseMetaBatch.fromXDR(raw).ledgerCloseMeta()) {
    const closed = meta.value() as xdr.LedgerCloseMetaV1 | xdr.LedgerCloseMetaV2;
    const header = closed.ledgerHeader();
    const sequence = header.header().ledgerSeq();
    if (sequence < from || sequence >= next) continue;
    let matched = false;
    closed.txProcessing().forEach((processing, transactionIndex) => {
      const result = processing.result();
      const hash = result.transactionHash().toString("hex");
      const events = transactionEvents(processing.txApplyProcessing(), { transactionHash: hash, ledger: sequence, transactionIndex });
      if (!events.some((e) => wanted.has(e.contract) || e.topics.some((t) => typeof t === "string" && wanted.has(t)))) return;
      const fee = events.find((e) => e.operationIndex === null && e.topics[0] === "fee");
      batch.transactions.push({
        hash,
        ledger: sequence,
        transactionIndex,
        feeSource: typeof fee?.topics[1] === "string" ? fee.topics[1] : "",
        feeCharged: BigInt(result.result().feeCharged().toString()),
        success: succeeded.has(result.result().result().switch().name),
      });
      append(batch.events, events);
      matched = true;
    });
    if (matched) batch.ledgers.push({ sequence, closeTime: Number(header.header().scpValue().closeTime().toString()), hash: header.hash().toString("hex") });
  }
}

/** A transaction's events in the order they happened: the fee charged, its operations', then the refund. */
function transactionEvents(meta: xdr.TransactionMeta, at: Pick<StellarEvent, "transactionHash" | "ledger" | "transactionIndex">): StellarEvent[] {
  if (meta.switch() !== 4) return [];
  const v4 = meta.v4();
  const charged = v4.events().filter((e) => e.stage() === xdr.TransactionEventStage.transactionEventStageBeforeAllTxes());
  const refunded = v4.events().filter((e) => e.stage() !== xdr.TransactionEventStage.transactionEventStageBeforeAllTxes());
  const raw: Array<[number | null, xdr.ContractEvent]> = [
    ...charged.map((e): [null, xdr.ContractEvent] => [null, e.event()]),
    ...v4.operations().flatMap((op, i) => op.events().map((e): [number, xdr.ContractEvent] => [i, e])),
    ...refunded.map((e): [null, xdr.ContractEvent] => [null, e.event()]),
  ];
  return raw.map(([operationIndex, event], eventIndex) => {
    const body = event.body().v0();
    const contract = event.contractId();
    return { ...at, operationIndex, eventIndex, contract: contract ? StrKey.encodeContract(contract as unknown as Buffer) : "", topics: body.topics().map(native), data: native(body.data()) };
  });
}

function native(value: xdr.ScVal): unknown {
  try {
    return scValToNative(value);
  } catch {
    return value.toXDR("base64");
  }
}
