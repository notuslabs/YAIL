import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { existsSync, watch } from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { Indexer } from "../indexer/indexer.js";
import { schemaDdl } from "../db/migrate.js";
import { recordEvmFixture, recordBitcoinFixture, recordSolanaFixture, writeFixture, type Fixture } from "../sources/fixture.js";
import { bigintReplacer } from "../util.js";
import { buildAddressQuery, buildEvmQuery } from "../indexer/plan.js";

const HELP = `yail <command> [options]

Commands
  start [entry]           run the indexer (default entry: src/index.ts)
  dev [entry]             run and restart on file changes
  migrate [entry]         create database, tables and materialized views
                          --populate  backfill materialized views from existing data
                          --reset     drop and recreate user tables (dev only)
  ddl [entry]             print the DDL statements
  reindex [entry]         --chain <name> (--from <block> --to <block> | --scope <name> --value <id>)
  addresses add [entry]   --set <name> [--chain <name>] [--from-block <n>] <address...>
  addresses list [entry]  [--set <name>] [--chain <name>] [--status <s>]
  record [entry]          --chain <name> --from <block> --to <block> --out <file.json>
  status                  fetch /status from a running indexer (--url http://localhost:42069)

The entry module must export the indexer (default export or \`indexer\`).`;

export async function run(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      populate: { type: "boolean" },
      reset: { type: "boolean" },
      chain: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      scope: { type: "string" },
      value: { type: "string" },
      set: { type: "string" },
      status: { type: "string" },
      "from-block": { type: "string" },
      out: { type: "string" },
      url: { type: "string" },
      "no-server": { type: "boolean" },
    },
  });
  const [command, ...rest] = positionals;
  if (command && !["start", "dev"].includes(command)) process.env.YAIL_QUIET ??= "1";
  if (!command || values.help) {
    console.log(HELP);
    return;
  }

  if (command === "status") {
    const res = await fetch(`${values.url ?? "http://localhost:42069"}/status`);
    console.log(JSON.stringify(await res.json(), null, 2));
    return;
  }

  if (command === "addresses") {
    const [sub, ...more] = rest;
    const entry = more.find((a) => a.endsWith(".ts") || a.endsWith(".js"));
    const indexer = await loadIndexer(entry);
    if (sub === "add") {
      if (!values.set) fail("--set is required");
      const addrs = more.filter((a) => !(a.endsWith(".ts") || a.endsWith(".js")));
      if (addrs.length === 0) fail("at least one address is required");
      const rows = await indexer.addresses.register(addrs.map((address) => ({ set: values.set!, address, chain: values.chain, fromBlock: optionalNumber(values["from-block"]) })));
      console.log(JSON.stringify(rows, bigintReplacer, 2));
      await indexer.stop();
      return;
    }
    if (sub === "list") {
      await indexer.init();
      console.log(JSON.stringify(indexer.addresses.list({ set: values.set, chain: values.chain, status: values.status as any }), bigintReplacer, 2));
      await indexer.stop();
      return;
    }
    fail(`unknown addresses subcommand "${sub}"`);
  }

  const entry = rest[0];
  switch (command) {
    case "start": {
      const indexer = await loadIndexer(entry);
      const stop = () => indexer.stop().then(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await indexer.start({ server: !values["no-server"] });
      return;
    }
    case "dev": {
      devLoop(entry);
      return;
    }
    case "migrate": {
      const indexer = await loadIndexer(entry);
      await indexer.migrate({ populate: values.populate, reset: values.reset, log: (m) => console.log(`[migrate] ${m}`) });
      await indexer.stop();
      console.log("migrated");
      return;
    }
    case "ddl": {
      const indexer = await loadIndexer(entry);
      console.log(schemaDdl(indexer.schema, indexer.config.database.database).join(";\n\n") + ";");
      return;
    }
    case "reindex": {
      if (!values.chain) fail("--chain is required");
      const indexer = await loadIndexer(entry);
      const rows = await indexer.reindex({
        chain: values.chain!,
        fromBlock: optionalNumber(values.from),
        toBlock: optionalNumber(values.to),
        scope: values.scope,
        value: values.value,
      });
      console.log(`queued ${rows.length} job(s): ${rows.map((r) => r.id).join(", ")}. A running indexer picks them up within 10s.`);
      await indexer.stop();
      return;
    }
    case "record": {
      if (!values.chain || !values.from || !values.to || !values.out) fail("--chain, --from, --to and --out are required");
      const indexer = await loadIndexer(entry);
      await indexer.init();
      const plan = indexer.internals.plans.get(values.chain!);
      if (!plan) fail(`unknown chain ${values.chain}`);
      const registry = indexer.internals.registry;
      const from = Number(values.from);
      const to = Number(values.to);
      const source = plan!.config.source;
      let fixture: Fixture;
      if (plan!.kind === "evm") {
        fixture = await recordEvmFixture(source as any, buildEvmQuery(plan!, from, to, registry), { name: values.chain, chainId: Number(plan!.config.id) });
      } else if (plan!.kind === "solana") {
        fixture = await recordSolanaFixture(source as any, buildAddressQuery(plan!, from, to, registry), { name: values.chain });
      } else {
        fixture = await recordBitcoinFixture(source as any, buildAddressQuery(plan!, from, to, registry), { name: values.chain });
      }
      writeFixture(resolve(values.out!), fixture);
      console.log(`wrote ${values.out}`);
      await indexer.stop();
      return;
    }
    default:
      fail(`unknown command "${command}"\n\n${HELP}`);
  }
}

async function loadIndexer(entry = "src/index.ts"): Promise<Indexer<any>> {
  const path = resolve(process.cwd(), entry);
  if (!existsSync(path)) fail(`entry not found: ${path}`);
  const { tsImport } = await import("tsx/esm/api");
  const mod = await tsImport(pathToFileURL(path).href, import.meta.url);
  const indexer = mod.default ?? mod.indexer;
  if (!indexer || typeof indexer.on !== "function") fail(`${entry} must export the indexer as default export or \`indexer\``);
  return indexer as Indexer<any>;
}

function devLoop(entry?: string): void {
  let child: ReturnType<typeof spawn> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const startChild = () => {
    const args = [process.argv[1]!, "start"];
    if (entry) args.push(entry);
    child = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "development" } });
    child.on("exit", (code) => {
      if (code !== null && code !== 0) console.error(`[yail dev] indexer exited with code ${code}, waiting for changes...`);
    });
  };
  const restart = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      console.log("[yail dev] change detected, restarting");
      if (child && child.exitCode === null) {
        child.once("exit", startChild);
        child.kill("SIGTERM");
      } else startChild();
    }, 300);
  };
  const dirs = [resolve(process.cwd(), "src")].filter(existsSync);
  for (const d of dirs) watch(d, { recursive: true }, restart);
  for (const f of ["yail.config.ts", "yail.config.js"]) if (existsSync(f)) watch(f, restart);
  startChild();
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Number(value);
}
