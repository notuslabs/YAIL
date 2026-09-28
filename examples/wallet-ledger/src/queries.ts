import { sql, type Db } from "yail";
import { ledgerEntries, walletDailyFlows } from "./schema.js";

/**
 * Query helpers an API can call directly. They are plain SQL over the tables
 * the indexer writes; nothing here depends on the indexer process.
 */

export interface BalancePoint {
  day: string;
  chain: string;
  asset: string;
  balance: bigint;
  inflow: bigint;
  outflow: bigint;
}

/** Running balance per asset per day (raw units). Fill gaps client-side or with WITH FILL. */
export async function balanceSeries(db: Db, wallet: string, options: { chain?: string; from?: Date; to?: Date } = {}): Promise<BalancePoint[]> {
  const rows = await db.query<{ day: string; chain: string; asset: string; balance: string; inflow: string; outflow: string }>(sql`
    SELECT day, chain, asset,
           sum(inflow - outflow) OVER (PARTITION BY chain, asset ORDER BY day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance,
           inflow, outflow
    FROM (
      SELECT day, chain, asset, sum(inflow) AS inflow, sum(outflow) AS outflow
      FROM ${walletDailyFlows}
      WHERE wallet = ${wallet.toLowerCase()}
        ${options.chain ? sql`AND chain = ${options.chain}` : sql.empty()}
      GROUP BY day, chain, asset
    )
    ${options.from || options.to ? sql`WHERE 1 ${options.from ? sql`AND day >= ${options.from}` : sql.empty()} ${options.to ? sql`AND day <= ${options.to}` : sql.empty()}` : sql.empty()}
    ORDER BY chain, asset, day`);
  return rows.map((r) => ({ ...r, balance: BigInt(r.balance), inflow: BigInt(r.inflow), outflow: BigInt(r.outflow) }));
}

/** Current balance per asset reconstructed from the ledger (raw units). Compare against a provider to reconcile. */
export async function balances(db: Db, wallet: string): Promise<Array<{ chain: string; asset: string; balance: bigint }>> {
  const rows = await db.query<{ chain: string; asset: string; balance: string }>(sql`
    SELECT chain, asset, sumIf(toInt256(amount), direction = 'in') - sumIf(toInt256(amount), direction = 'out') AS balance
    FROM ${ledgerEntries} FINAL
    WHERE wallet = ${wallet.toLowerCase()}
    GROUP BY chain, asset
    ORDER BY chain, asset`);
  return rows.map((r) => ({ ...r, balance: BigInt(r.balance) }));
}

/** Deposits and withdrawals in a period: what the "Resultado em 3M" summary needs. */
export async function flowsInPeriod(db: Db, wallet: string, from: Date, to: Date): Promise<Array<{ chain: string; asset: string; inflow: bigint; outflow: bigint }>> {
  const rows = await db.query<{ chain: string; asset: string; inflow: string; outflow: string }>(sql`
    SELECT chain, asset, sum(inflow) AS inflow, sum(outflow) AS outflow
    FROM ${walletDailyFlows}
    WHERE wallet = ${wallet.toLowerCase()} AND day >= ${from} AND day <= ${to}
    GROUP BY chain, asset ORDER BY chain, asset`);
  return rows.map((r) => ({ ...r, inflow: BigInt(r.inflow), outflow: BigInt(r.outflow) }));
}
