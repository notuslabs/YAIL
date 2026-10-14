import { base58Encode } from "./base58.js";

/** Reads bytes front to back. Codecs take what they need; what is left stays for the next field. */
export class Reader {
  private offset = 0;

  constructor(readonly bytes: Uint8Array) {}

  /** Bytes not read yet. */
  remaining(): number {
    return this.bytes.length - this.offset;
  }

  /** The next `length` bytes. RangeError when fewer are left. */
  take(length: number): Uint8Array {
    if (length > this.remaining()) throw new RangeError(`need ${length} bytes at offset ${this.offset}, ${this.remaining()} left`);
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }
}

/** Borsh-style decoder of one value: little-endian integers, `u32`-prefixed strings and vectors. */
export interface Codec<T> {
  read(reader: Reader): T;
}

export type Infer<C> = C extends Codec<infer T> ? T : never;

/**
 * Decode `bytes` with `codec`. Bytes past the codec's fields are ignored, so a layout that grew new trailing fields
 * still decodes with the old codec. Throws a RangeError when `bytes` is too short.
 */
export function decode<T>(codec: Codec<T>, bytes: Uint8Array): T {
  return codec.read(new Reader(bytes));
}

function codec<T>(read: (reader: Reader) => T): Codec<T> {
  return { read };
}

function unsigned(bytes: Uint8Array): bigint {
  return bytes.reduceRight((n, byte) => (n << 8n) | BigInt(byte), 0n);
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString("hex");
}

function struct<F extends Record<string, Codec<unknown>>>(fields: F): Codec<{ [K in keyof F]: Infer<F[K]> }>;
function struct(fields: Record<string, Codec<unknown>>): Codec<Record<string, unknown>> {
  return codec((reader) => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.read(reader)])));
}

/** Codecs for the Borsh types Solana programs use. Hex comes without `0x`, pubkeys as base58. */
export const b = {
  u8: codec((reader) => Number(unsigned(reader.take(1)))),
  u16: codec((reader) => Number(unsigned(reader.take(2)))),
  u32: codec((reader) => Number(unsigned(reader.take(4)))),
  i32: codec((reader) => Number(BigInt.asIntN(32, unsigned(reader.take(4))))),
  u64: codec((reader) => unsigned(reader.take(8))),
  i64: codec((reader) => BigInt.asIntN(64, unsigned(reader.take(8)))),
  u128: codec((reader) => unsigned(reader.take(16))),
  i128: codec((reader) => BigInt.asIntN(128, unsigned(reader.take(16)))),
  bool: codec((reader) => unsigned(reader.take(1)) !== 0n),
  pubkey: codec((reader) => base58Encode(reader.take(32))),
  string: codec((reader) => Buffer.from(reader.take(Number(unsigned(reader.take(4))))).toString("utf8")),
  /** Every byte left, as hex: fields after variable-length data whose layout changed over time. */
  rest: codec((reader) => hex(reader.take(reader.remaining()))),
  bytes: (length: number) => codec((reader) => hex(reader.take(length))),
  option: <T>(inner: Codec<T>) => codec((reader) => (unsigned(reader.take(1)) === 0n ? null : inner.read(reader))),
  vec: <T>(inner: Codec<T>) => codec((reader) => Array.from({ length: Number(unsigned(reader.take(4))) }, () => inner.read(reader))),
  array: <T>(inner: Codec<T>, length: number) => codec((reader) => Array.from({ length }, () => inner.read(reader))),
  /** Fields in declaration order. */
  struct,
};
