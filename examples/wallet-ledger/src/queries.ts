import { sql, type Db } from "yail";
import { ledger } from "./schema.js";

/** Daily balance curve of one wallet per chain and asset, in the asset's smallest unit. Exact: computed from the ledger itself. */
export async function balanceSeries(db: Db, wallet: string) {
  const rows = await db.query<{ chain: string; asset: string; day: string; balance: string }>(sql`
    SELECT chain, asset, day, sum(net) OVER (PARTITION BY chain, asset ORDER BY day) AS balance
    FROM (
      SELECT chain, asset, toDate(block_time) AS day,
             sumIf(toInt256(amount), direction = 'in') - sumIf(toInt256(amount), direction = 'out') AS net
      FROM ${ledger} FINAL
      WHERE wallet = ${wallet.toLowerCase()}
      GROUP BY chain, asset, day
    )
    ORDER BY chain, asset, day`);
  return rows.map((r) => ({ ...r, balance: BigInt(r.balance) }));
}
