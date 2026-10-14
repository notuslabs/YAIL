import { createHash } from "node:crypto";
import { b, type Codec } from "./codec.js";

/** First 8 bytes of every `emit_cpi!` event instruction (Anchor's event tag), before the event's own discriminator. */
export const EMIT_CPI_TAG = "e445a52e51cb9a1d";

/** An instruction a program handles, recognized by the first bytes of its data. */
export interface InstructionDef<args = unknown, account extends string = string> {
  kind: "instruction";
  /** Hex prefix of the instruction data (1, 2, 4 or 8 bytes). The arguments start after it. */
  discriminator: string;
  args: Codec<args>;
  /** Names of the instruction's accounts, in order: `event.accounts.<name>`. */
  accounts: readonly account[];
}

/** An event a program emits, recognized by the first bytes of its payload. */
export interface EventDef<data = unknown> {
  kind: "event";
  /** Hex prefix of the event payload. The fields start after it. */
  discriminator: string;
  data: Codec<data>;
}

/** An instruction by its discriminator: the tag byte of a native program, or 8 bytes of an Anchor one. */
export function instruction<args, const account extends string = never>(def: { discriminator: string; args: Codec<args>; accounts?: readonly account[] }): InstructionDef<args, account>;
export function instruction<const account extends string = never>(def: { discriminator: string; accounts?: readonly account[] }): InstructionDef<Record<string, never>, account>;
export function instruction(def: { discriminator: string; args?: Codec<unknown>; accounts?: readonly string[] }): InstructionDef {
  return { kind: "instruction", discriminator: def.discriminator, args: def.args ?? b.struct({}), accounts: def.accounts ?? [] };
}

/** An Anchor instruction: its discriminator is `sha256("global:<name>")`, `name` in snake_case. */
export function anchorInstruction<args, const account extends string = never>(name: string, def: { args: Codec<args>; accounts?: readonly account[] }): InstructionDef<args, account>;
export function anchorInstruction<const account extends string = never>(name: string, def?: { accounts?: readonly account[] }): InstructionDef<Record<string, never>, account>;
export function anchorInstruction(name: string, def: { args?: Codec<unknown>; accounts?: readonly string[] } = {}): InstructionDef {
  return { kind: "instruction", discriminator: anchorDiscriminator("global", name), args: def.args ?? b.struct({}), accounts: def.accounts ?? [] };
}

/** An Anchor event: its discriminator is `sha256("event:<Name>")`. */
export function anchorEvent<data>(name: string, data: Codec<data>): EventDef<data> {
  return { kind: "event", discriminator: anchorDiscriminator("event", name), data };
}

/** First 8 bytes of `sha256("<namespace>:<name>")`, as hex. */
export function anchorDiscriminator(namespace: "global" | "event", name: string): string {
  return createHash("sha256").update(`${namespace}:${name}`).digest("hex").slice(0, 16);
}

/** Bytes of a `Program data:` line: with its prefix (RPC `logMessages`) or without it (HyperSync). */
export function programData(message: string): Uint8Array {
  return Buffer.from(message.replace(/^Program data: /, ""), "base64");
}

/** Text of a `Program log:` line, without its prefix. */
export function programLog(message: string): string {
  return message.replace(/^Program log: /, "");
}
