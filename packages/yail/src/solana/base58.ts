const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 text of `bytes` (Solana pubkeys and signatures). */
export function base58Encode(bytes: Uint8Array): string {
  let n = bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
  let out = "";
  while (n > 0n) {
    out = ALPHABET.charAt(Number(n % 58n)) + out;
    n /= 58n;
  }
  const zeros = bytes.findIndex((byte) => byte !== 0);
  return "1".repeat(zeros === -1 ? bytes.length : zeros) + out;
}

/** Bytes of base58 `text`. Throws on a character outside the alphabet. */
export function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const char of text) {
    const digit = ALPHABET.indexOf(char);
    if (digit === -1) throw new Error(`base58: invalid character "${char}" in "${text}"`);
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 255n));
  const zeros = text.length - text.replace(/^1+/, "").length;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes]);
}
