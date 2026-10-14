import { describe, expect, it } from "vitest";
import { Reader, anchorDiscriminator, anchorEvent, anchorInstruction, b, base58Decode, base58Encode, decode, instruction, programData, programLog, type Codec } from "../src/solana/index.js";

const bytes = (...values: number[]) => Uint8Array.from(values);
const le = (n: bigint, size: number) => Uint8Array.from({ length: size }, (_, i) => Number((n >> BigInt(8 * i)) & 255n));

describe("solana codec", () => {
  it("reads integers at their boundaries, negative ones included", () => {
    expect(decode(b.u64, le(2n ** 64n - 1n, 8))).toBe(2n ** 64n - 1n);
    expect(decode(b.u64, le(0n, 8))).toBe(0n);
    expect(decode(b.u128, le(2n ** 128n - 1n, 16))).toBe(2n ** 128n - 1n);
    expect(decode(b.u128, le(2n ** 64n, 16))).toBe(2n ** 64n);
    expect(decode(b.i32, bytes(0xff, 0xff, 0xff, 0xff))).toBe(-1);
    expect(decode(b.i32, bytes(0, 0, 0, 0x80))).toBe(-(2 ** 31));
    expect(decode(b.i64, le(2n ** 64n - 2n, 8))).toBe(-2n);
    expect(decode(b.i128, le(2n ** 128n - 1n, 16))).toBe(-1n);
    expect(decode(b.u16, bytes(0x34, 0x12))).toBe(0x1234);
    expect(decode(b.u32, bytes(1, 0, 0, 1))).toBe(2 ** 24 + 1);
    expect(decode(b.bool, bytes(1))).toBe(true);
  });

  it("encodes and decodes base58", () => {
    const token = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    expect(base58Encode(new TextEncoder().encode("Hello World!"))).toBe("2NEpo7TZRRrLZSi2U");
    expect(Buffer.from(base58Decode(token)).toString("hex")).toBe("06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9");
    expect(decode(b.pubkey, base58Decode(token))).toBe(token);
    expect(base58Encode(new Uint8Array(32))).toBe("11111111111111111111111111111111");
    expect(Buffer.from(base58Decode("112")).toString("hex")).toBe("000001");
    expect(() => base58Decode("0OIl")).toThrow(/invalid character/);
  });

  it("reads options, vectors, strings and structs in order", () => {
    const codec = b.struct({ some: b.option(b.u8), none: b.option(b.u8), list: b.vec(b.u16), name: b.string, pair: b.array(b.u8, 2), tag: b.bytes(2) });
    const data = bytes(1, 7, 0, 2, 0, 0, 0, 1, 0, 2, 0, 3, 0, 0, 0, 0x61, 0x62, 0x63, 9, 8, 0xab, 0xcd);
    expect(decode(codec, data)).toEqual({ some: 7, none: null, list: [1, 2], name: "abc", pair: [9, 8], tag: "abcd" });
  });

  it("ignores trailing bytes and throws on a short buffer", () => {
    expect(decode(b.struct({ x: b.u8 }), bytes(5, 6, 7))).toEqual({ x: 5 });
    expect(() => decode(b.u64, bytes(1, 2, 3))).toThrow(RangeError);
    expect(() => decode(b.struct({ x: b.u8, y: b.u32 }), bytes(1, 2))).toThrow(RangeError);
  });

  it("reads fields that only some eras have with remaining(), and keeps the rest as hex", () => {
    const head = b.struct({ x: b.u8 });
    const versioned: Codec<{ x: number; y: number | null }> = { read: (reader) => ({ ...head.read(reader), y: reader.remaining() >= 2 ? b.u16.read(reader) : null }) };
    expect(decode(versioned, bytes(1))).toEqual({ x: 1, y: null });
    expect(decode(versioned, bytes(1, 2, 0, 9))).toEqual({ x: 1, y: 2 });
    expect(decode(b.struct({ x: b.u8, rest: b.rest }), bytes(1, 0xde, 0xad))).toEqual({ x: 1, rest: "dead" });
    expect(decode(b.struct({ x: b.u8, rest: b.rest }), bytes(1))).toEqual({ x: 1, rest: "" });
    const reader = new Reader(bytes(1, 2, 3));
    reader.take(1);
    expect(reader.remaining()).toBe(2);
  });
});

describe("solana program definitions", () => {
  it("computes Anchor discriminators", () => {
    expect(anchorDiscriminator("event", "SwapEvent")).toBe("40c6cde8260871e2");
    expect(anchorDiscriminator("global", "swap")).toBe("f8c69e91e17587c8");
    expect(anchorEvent("SwapEvent", b.struct({})).discriminator).toBe("40c6cde8260871e2");
    expect(anchorInstruction("swap_v2").discriminator).toBe("2b04ed0b1ac91e62");
    expect(instruction({ discriminator: "09" })).toMatchObject({ kind: "instruction", discriminator: "09", accounts: [] });
  });

  it("reads Program data lines with or without their prefix", () => {
    expect(Buffer.from(programData("Program data: QMbN6CYIceI=")).toString("hex")).toBe("40c6cde8260871e2");
    expect(Buffer.from(programData("QMbN6CYIceI=")).toString("hex")).toBe("40c6cde8260871e2");
    expect(programLog("Program log: ray_log: CQ==")).toBe("ray_log: CQ==");
    expect(programLog("ray_log: CQ==")).toBe("ray_log: CQ==");
  });
});
