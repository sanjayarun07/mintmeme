import { onchainTable, index } from 'ponder';

/** One row per V2 pair we index: which side is the base token and which is the quote. */
export const pool = onchainTable('pool', t => ({
  id: t.text().primaryKey(),                 // `${chain}:${pairAddress}`
  chain: t.text().notNull(), address: t.text().notNull(),
  token0: t.text().notNull(), token1: t.text().notNull(),
  quoteIs0: t.boolean().notNull(),           // true when token0 is the quote (stablecoin or wrapped native)
  quoteKind: t.text().notNull(),             // 'stable' | 'native' | 'none'
  quoteDecimals: t.integer().notNull(),
}));
/** Latest reserves per pool (from Sync), used to price the native token. */
export const reserves = onchainTable('reserves', t => ({
  id: t.text().primaryKey(), r0: t.bigint().notNull(), r1: t.bigint().notNull(),
}));
/** Every swap in a tracked pool. `usd` is the quote side of the trade valued in USD; null when the pool has no recognised quote or the native price is not known yet. */
export const trade = onchainTable('trade', t => ({
  id: t.text().primaryKey(),                 // `${chain}:${tx}:${logIndex}`
  chain: t.text().notNull(), pool: t.text().notNull(),
  side: t.text().notNull(),                  // buy | sell of the BASE token
  wallet: t.text().notNull(),                // transaction sender as read from the chain
  usd: t.doublePrecision(), tx: t.text().notNull(),
  ts: t.integer().notNull(), block: t.bigint().notNull(),
}), table => ({ byTime: index().on(table.ts), byPool: index().on(table.pool) }));
