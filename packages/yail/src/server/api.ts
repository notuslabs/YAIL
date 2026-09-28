import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Indexer } from "../indexer/indexer.js";
import { jobs as jobsTable } from "../db/internal.js";
import { sql } from "../db/sql.js";
import { bigintReplacer, toArray } from "../util.js";

export function createApp(indexer: Indexer<any>): Hono {
  const app = new Hono();

  app.get("/health", async (c) => {
    const status = await indexer.status();
    const failed = Object.values(status.chains).filter((ch) => ch.error);
    return c.json({ ok: failed.length === 0, failed: failed.length }, statusCode(failed.length === 0));
  });

  app.get("/ready", async (c) => {
    const status = await indexer.status();
    const ready = Object.values(status.chains).every((ch) => ch.caughtUp && !ch.error);
    return c.json({ ready, chains: Object.fromEntries(Object.entries(status.chains).map(([k, v]) => [k, { caughtUp: v.caughtUp, lagBlocks: v.lagBlocks }])) }, statusCode(ready));
  });

  app.get("/status", async (c) => c.json(await indexer.status()));

  app.get("/addresses", (c) => {
    const set = c.req.query("set");
    const chain = c.req.query("chain");
    const status = c.req.query("status") as any;
    return c.json(indexer.addresses.list({ set, chain, status }).map(serializable));
  });

  app.post("/addresses", async (c) => {
    const body = await c.req.json<{ set: string; address: string | string[]; chain?: string; fromBlock?: number; meta?: Record<string, unknown> }>();
    if (!body.set || !body.address) return c.json({ error: "set and address are required" }, 400);
    const list = toArray(body.address).map((address) => ({ set: body.set, address, chain: body.chain, fromBlock: body.fromBlock, meta: body.meta }));
    const rows = await indexer.addresses.register(list);
    return c.json(rows.map(serializable), 201);
  });

  app.post("/reindex", async (c) => {
    const body = await c.req.json<{ chain: string; fromBlock?: number; toBlock?: number; scope?: string; value?: string }>();
    try {
      const rows = await indexer.reindex(body);
      return c.json(rows.map(serializable), 202);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.get("/jobs", async (c) => {
    const rows = await indexer.db.rows(jobsTable, sql`ORDER BY created_at DESC LIMIT 200`);
    return c.json(rows.map(serializable));
  });

  app.get("/_evlog/logs", (c) => {
    const limit = Number(c.req.query("limit") ?? 100);
    return c.json(indexer.observability.recentEvents(limit));
  });

  return app;
}

export async function startServer(indexer: Indexer<any>, options: { port: number; hostname?: string }): Promise<{ close(): Promise<void>; port: number }> {
  const app = createApp(indexer);
  const server = serve({ fetch: app.fetch, port: options.port, hostname: options.hostname ?? "0.0.0.0" });
  const port = (server.address() as any)?.port ?? options.port;
  indexer.observability.log.info("yail", `status API listening on http://${options.hostname ?? "0.0.0.0"}:${port} (/status, /health, /addresses, /reindex, /jobs)`);
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function statusCode(ok: boolean): 200 | 503 {
  if (ok) return 200;
  return 503;
}

function serializable<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, bigintReplacer));
}
