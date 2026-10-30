/**
 * The Arrow whole-blocks reader against HyperSync responses recorded from gnosis-traces on 2026-10-30, one
 * block a response: what it keeps must be exactly what the client's get() returned for the same blocks, matched.
 */
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { hypersync } from "../src/sources/hypersync.js";
import { evmMatcher, wholeBlocksQuery } from "../src/sources/match.js";
import { reviveBatch } from "../src/sources/cached.js";
import type { EvmBatch, EvmQuery } from "../src/sources/types.js";

const fixtures = new URL("./fixtures/hypersync-arrow-gnosis/", import.meta.url).pathname;
const { query, expected } = reviveBatch(readFileSync(`${fixtures}expected.json`, "utf8")) as { query: EvmQuery; expected: EvmBatch };

let server: Server | undefined;
afterEach(() => {
  server?.close();
});

/** Serves the recorded response of each request's `from_block`, after the given failures. */
async function serve(failures: Array<{ status: number; headers?: Record<string, string> }> = []) {
  const asked: number[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const failure = failures.shift();
      if (failure) {
        res.writeHead(failure.status, failure.headers).end("unavailable");
        return;
      }
      const from = JSON.parse(body).from_block as number;
      asked.push(from);
      res.writeHead(200, { "content-type": "application/octet-stream", "x-ratelimit-remaining": "999", "x-ratelimit-reset": "60" }).end(readFileSync(`${fixtures}${from}.bin`));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return { url, asked };
}

async function read(url: string, apiToken: string): Promise<EvmBatch[]> {
  const source = hypersync({ url, traces: { url }, apiToken });
  const match = evmMatcher(query);
  const batches: EvmBatch[] = [];
  for await (const batch of source.fetch(wholeBlocksQuery(query), { match })) batches.push(batch);
  return batches;
}

const items = ({ blocks, transactions, logs, traces }: EvmBatch) => ({ blocks, transactions, logs, traces });

describe("hypersync Arrow whole blocks", () => {
  it("keeps from recorded responses exactly what get() matched, as one batch", async () => {
    const { url, asked } = await serve();
    const batches = await read(url, "recorded");
    expect(batches).toHaveLength(1);
    expect(batches[0]!.fromBlock).toBe(query.fromBlock);
    expect(batches[0]!.nextBlock).toBe(query.toBlock);
    expect(items(batches[0]!)).toEqual(items(expected));
    expect(expected.traces!.length).toBeGreaterThan(0);
    expect(asked.sort()).toEqual([query.fromBlock, query.fromBlock + 1, query.fromBlock + 2, query.fromBlock + 3]);
  });

  it("waits out a 429 and retries a server error", async () => {
    const { url } = await serve([{ status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" } }, { status: 503 }]);
    const started = performance.now();
    const batches = await read(url, "limited");
    expect(items(batches[0]!)).toEqual(items(expected));
    expect(performance.now() - started).toBeGreaterThan(1_000);
  });
});
