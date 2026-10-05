/**
 * Records real on-chain data into test/fixtures/*.json together with ground
 * truth read from the chain at the same blocks. Re-run to refresh:
 *   pnpm tsx scripts/record-fixtures.ts [pool|usdc|bitcoin|solana]
 * `solana` needs ENVIO_API_TOKEN (HyperSync); SOLANA_RPC_URL defaults to the public mainnet RPC.
 */
import { createPublicClient, http, parseAbi, toEventSelector } from "viem";
import { rpc } from "../src/sources/rpc.js";
import { esplora } from "../src/sources/esplora.js";
import { hypersyncSolana } from "../src/sources/hypersync-solana.js";
import { solanaRpc } from "../src/sources/solana-rpc.js";
import { recordEvmFixture, recordBitcoinFixture, recordSolanaFixture, writeFixture } from "../src/sources/fixture.js";
import { padAddress } from "../src/indexer/events.js";

const BASE_RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const ESPLORA = process.env.ESPLORA_URL ?? "https://mempool.space/api";
const SOLANA_RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const SOLANA_WALLET = process.env.SOLANA_WALLET ?? "8dVSpuXXqZmvsTJbTTut7acjhxUmknABHR6RhSkPNawV"; // a few hundred txs since 2026-10-01, ~50 tokens
const POOL = "0xd0b53d9277642d899df5c87a3966a349a798f224"; // Uniswap V3 WETH/USDC 0.05% on Base
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const POOL_RANGE = { from: 51_800_000, to: 51_800_150 };
const USDC_RANGE = { from: 51_800_000, to: 51_800_060 };

const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

// Ground-truth reads (archive eth_call) go to a separate endpoint; base.drpc.org serves archive state without a key.
const READ_RPC = process.env.BASE_READ_RPC_URL ?? "https://base.drpc.org";
const client = createPublicClient({ transport: http(READ_RPC, { retryCount: 6, retryDelay: 1500 }) });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const source = rpc({ url: BASE_RPC, blockRange: 50, concurrency: 3 });
const out = new URL("../test/fixtures/", import.meta.url).pathname;

async function recordPool() {
  const topics = [toEventSelector(poolAbi[2]), toEventSelector(poolAbi[3]), toEventSelector(poolAbi[4])];
  const fixture = await recordEvmFixture(source, { fromBlock: POOL_RANGE.from, toBlock: POOL_RANGE.to, logs: [{ address: [POOL], topics: [topics] }], transactions: [] }, { name: "base-univ3-weth-usdc", chainId: 8453 });
  const endBlock = BigInt(POOL_RANGE.to - 1);
  const slot0 = await client.readContract({ address: POOL, abi: poolAbi, functionName: "slot0", blockNumber: endBlock });
  const liquidity = await client.readContract({ address: POOL, abi: poolAbi, functionName: "liquidity", blockNumber: endBlock });
  const startSlot0 = await client.readContract({ address: POOL, abi: poolAbi, functionName: "slot0", blockNumber: BigInt(POOL_RANGE.from - 1) });
  const startLiquidity = await client.readContract({ address: POOL, abi: poolAbi, functionName: "liquidity", blockNumber: BigInt(POOL_RANGE.from - 1) });
  fixture.expected = {
    pool: POOL,
    endBlock: Number(endBlock),
    sqrtPriceX96: slot0[0],
    tick: slot0[1],
    liquidity,
    startSqrtPriceX96: startSlot0[0],
    startTick: startSlot0[1],
    startLiquidity,
  };
  writeFixture(`${out}base-univ3-weth-usdc.json`, fixture);
  console.log(`pool: ${fixture.logs.length} logs, ${fixture.blocks.length} blocks`);
}

async function recordUsdc() {
  const transferTopic = toEventSelector(erc20Abi[1]);
  const all = await recordEvmFixture(source, { fromBlock: USDC_RANGE.from, toBlock: USDC_RANGE.to, logs: [{ address: [USDC], topics: [[transferTopic]] }], transactions: [] });
  const counts = new Map<string, number>();
  for (const l of all.logs) {
    for (const t of [l.topics[1], l.topics[2]]) {
      if (!t) continue;
      const a = `0x${t.slice(-40)}`;
      if (a === "0x0000000000000000000000000000000000000000") continue;
      counts.set(a, (counts.get(a) ?? 0) + 1);
    }
  }
  // Wallets: a mix of busy (top) and quiet (3-6 transfers) addresses, all with a checksum-able code-free profile is not required.
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const busy = sorted.slice(0, 2).map(([a]) => a);
  const quiet = sorted.filter(([, c]) => c >= 3 && c <= 6).slice(0, 3).map(([a]) => a);
  const wallets = [...busy, ...quiet];
  console.log("wallets:", wallets.map((w) => `${w} (${counts.get(w)})`).join(", "));
  const padded = wallets.map(padAddress);
  const fixture = await recordEvmFixture(
    source,
    {
      fromBlock: USDC_RANGE.from,
      toBlock: USDC_RANGE.to,
      logs: [
        { address: [USDC], topics: [[transferTopic], padded] },
        { address: [USDC], topics: [[transferTopic], null, padded] },
      ],
      transactions: [{ from: wallets }, { to: wallets }],
      includeLogTransactions: true,
    },
    { name: "base-usdc-wallets", chainId: 8453 },
  );
  const balances: Record<string, { start: bigint; end: bigint }> = {};
  for (const w of wallets) {
    await pause(400);
    const start = await client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [w as `0x${string}`], blockNumber: BigInt(USDC_RANGE.from - 1) });
    const end = await client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [w as `0x${string}`], blockNumber: BigInt(USDC_RANGE.to - 1) });
    balances[w] = { start, end };
  }
  fixture.expected = { token: USDC, wallets, balances, fromBlock: USDC_RANGE.from, toBlock: USDC_RANGE.to };
  writeFixture(`${out}base-usdc-wallets.json`, fixture);
  console.log(`usdc: ${fixture.logs.length} logs, ${fixture.transactions.length} txs, ${fixture.blocks.length} blocks`);
}

async function recordBitcoin() {
  const get = async <T>(p: string): Promise<T> => {
    const r = await fetch(`${ESPLORA}${p}`);
    if (!r.ok) throw new Error(`${p}: ${r.status}`);
    const text = await r.text();
    if (text.startsWith("{") || text.startsWith("[")) return JSON.parse(text) as T;
    return text as T;
  };
  const tip = Number(await get<string>("/blocks/tip/height"));
  // Find a few dormant addresses with a short, fully confirmed history in a block ~1 day old.
  const target = tip - 150;
  const hash = await get<string>(`/block-height/${target}`);
  const txids = await get<string[]>(`/block/${hash}/txids`);
  const chosen: string[] = [];
  const stats: Record<string, unknown> = {};
  for (const txid of txids.slice(1, 60)) {
    const tx = await get<{ vout: Array<{ scriptpubkey_address?: string }> }>(`/tx/${txid}`);
    for (const o of tx.vout) {
      const a = o.scriptpubkey_address;
      if (!a || chosen.includes(a)) continue;
      const s = await get<{ chain_stats: { tx_count: number; funded_txo_sum: number; spent_txo_sum: number }; mempool_stats: { tx_count: number } }>(`/address/${a}`);
      if (s.chain_stats.tx_count >= 2 && s.chain_stats.tx_count <= 8 && s.mempool_stats.tx_count === 0) {
        chosen.push(a);
        stats[a] = { txCount: s.chain_stats.tx_count, balance: BigInt(s.chain_stats.funded_txo_sum - s.chain_stats.spent_txo_sum), funded: BigInt(s.chain_stats.funded_txo_sum), spent: BigInt(s.chain_stats.spent_txo_sum) };
        console.log("btc address:", a, stats[a]);
      }
      if (chosen.length >= 3) break;
    }
    if (chosen.length >= 3) break;
  }
  const src = esplora({ url: ESPLORA, concurrency: 1 });
  const fixture = await recordBitcoinFixture(src, { fromBlock: 0, toBlock: tip + 1, addresses: chosen }, { name: "bitcoin-dormant-wallets" });
  fixture.expected = { addresses: chosen, stats, tip };
  writeFixture(`${out}bitcoin-wallets.json`, fixture);
  console.log(`bitcoin: ${fixture.transactions.length} txs for ${chosen.length} addresses`);
}

/**
 * One wallet's whole history, read from HyperSync, plus its first transactions read again over RPC. The test replays
 * them through `union()` with HyperSync's floor moved up to `expected.floor`, so the start comes from RPC, and checks
 * the summed changes against the balances read from the chain at `expected.slot`.
 */
async function recordSolana() {
  const call = async <T>(method: string, params: unknown[]): Promise<T> => {
    const r = await fetch(SOLANA_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const body = (await r.json()) as { result?: T; error?: unknown };
    if (!body.result) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  };
  const sigs = await call<Array<{ slot: number }>>("getSignaturesForAddress", [SOLANA_WALLET, { limit: 1000 }]);
  if (sigs.length === 1000) throw new Error("pick a wallet with fewer than 1000 transactions");
  const first = sigs.at(-1)!.slot;
  // SOL and every open token account. The reads land on different slots: they agree when the wallet did nothing in between.
  const balance = await call<{ context: { slot: number }; value: number }>("getBalance", [SOLANA_WALLET, { commitment: "confirmed" }]);
  const slot = balance.context.slot;
  if (sigs[0]!.slot >= slot) throw new Error("the wallet just moved: run again");
  const tokens: Record<string, { mint: string; amount: bigint }> = {};
  for (const programId of ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]) {
    const res = await call<{ context: { slot: number }; value: Array<{ pubkey: string; account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string } } } } } }> }>(
      "getTokenAccountsByOwner",
      [SOLANA_WALLET, { programId }, { encoding: "jsonParsed", commitment: "confirmed", minContextSlot: slot }],
    );
    for (const a of res.value) tokens[a.pubkey] = { mint: a.account.data.parsed.info.mint, amount: BigInt(a.account.data.parsed.info.tokenAmount.amount) };
  }
  const [latest] = await call<Array<{ slot: number }>>("getSignaturesForAddress", [SOLANA_WALLET, { limit: 1 }]);
  if (latest!.slot !== sigs[0]!.slot) throw new Error("the wallet moved while its balances were read: run again");
  const hs = hypersyncSolana({ concurrency: 32 });
  while ((await hs.getHeight()) <= slot) await new Promise((r) => setTimeout(r, 2000));
  const query = { fromBlock: first, toBlock: slot + 1, addresses: [SOLANA_WALLET] };
  const fixture = await recordSolanaFixture(hs, query, { name: "solana-wallet-hypersync" });
  // HyperSync "starts" after the wallet's first ten transactions: those are read over RPC.
  const floor = fixture.transactions[9]!.slot + 1;
  const early = await recordSolanaFixture(solanaRpc({ url: SOLANA_RPC, concurrency: 1 }), { ...query, toBlock: floor }, { name: "solana-wallet-rpc" });
  fixture.firstBlock = floor;
  fixture.expected = { wallet: SOLANA_WALLET, first, slot, floor, lamports: BigInt(balance.value), tokens };
  writeFixture(`${out}solana-wallet-hypersync.json`, fixture);
  writeFixture(`${out}solana-wallet-rpc.json`, early);
  console.log(`solana: ${fixture.transactions.length} txs (${early.transactions.length} over RPC below ${floor}), ${Object.keys(tokens).length} token accounts, slot ${slot}`);
}

const which = process.argv[2];
if (!which || which === "pool") await recordPool();
if (!which || which === "usdc") await recordUsdc();
if (!which || which === "bitcoin") await recordBitcoin();
if (!which || which === "solana") await recordSolana();
