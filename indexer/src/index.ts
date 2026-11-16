import { ponder } from 'ponder:registry';
import { pool, reserves, trade } from 'ponder:schema';
import { pairAbi, erc20Abi } from '../abis/pair.ts';

const env = process.env;
const list = (k: string) => (env[k] ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const keys = list('INDEX_CHAINS');

/** Native token price in USD from the reference pool's latest reserves. null until that pool has synced once. */
async function nativePrice(context: any, chain: string): Promise<number | null> {
  const K = chain.toUpperCase(), ref = list(`INDEX_REF_POOL_${K}`)[0]; if (!ref) return null;
  const [p, r] = await Promise.all([context.db.find(pool, { id: `${chain}:${ref}` }), context.db.find(reserves, { id: `${chain}:${ref}` })]);
  if (!p || !r || p.quoteKind !== 'stable') return null;
  // the reference pool pairs the wrapped native with a stable: quote side = stable
  const stable = Number(p.quoteIs0 ? r.r0 : r.r1) / 10 ** p.quoteDecimals, native = Number(p.quoteIs0 ? r.r1 : r.r0) / 1e18;
  return native > 0 ? stable / native : null;
}
async function ensurePool(context: any, chain: string, address: string) {
  const id = `${chain}:${address}`, have = await context.db.find(pool, { id }); if (have) return have;
  const K = chain.toUpperCase(), stables = list(`INDEX_STABLES_${K}`), wrapped = list(`INDEX_WRAPPED_${K}`);
  const [t0, t1] = await Promise.all([context.client.readContract({ abi: pairAbi, address, functionName: 'token0' }), context.client.readContract({ abi: pairAbi, address, functionName: 'token1' })]) as string[];
  const a = t0.toLowerCase(), b = t1.toLowerCase();
  const kind = (x: string) => stables.includes(x) ? 'stable' : wrapped.includes(x) ? 'native' : 'none';
  // prefer a stablecoin as the quote, then the wrapped native
  const quoteIs0 = kind(a) === 'stable' ? true : kind(b) === 'stable' ? false : kind(a) === 'native';
  const quote = quoteIs0 ? a : b, quoteKind = kind(quote);
  const dec = quoteKind === 'none' ? 18 : Number(await context.client.readContract({ abi: erc20Abi, address: quote, functionName: 'decimals' }));
  await context.db.insert(pool).values({ id, chain, address, token0: a, token1: b, quoteIs0, quoteKind, quoteDecimals: dec });
  return context.db.find(pool, { id });
}

for (const chain of keys) {
  ponder.on(`Pair_${chain}:Sync` as any, async ({ event, context }: any) => {
    const address = event.log.address.toLowerCase(); await ensurePool(context, chain, address);
    await context.db.insert(reserves).values({ id: `${chain}:${address}`, r0: event.args.reserve0, r1: event.args.reserve1 }).onConflictDoUpdate({ r0: event.args.reserve0, r1: event.args.reserve1 });
  });
  ponder.on(`Pair_${chain}:Swap` as any, async ({ event, context }: any) => {
    const address = event.log.address.toLowerCase(), p = await ensurePool(context, chain, address), a = event.args;
    const [qIn, qOut, bIn, bOut] = p.quoteIs0 ? [a.amount0In, a.amount0Out, a.amount1In, a.amount1Out] : [a.amount1In, a.amount1Out, a.amount0In, a.amount0Out];
    const side = bOut > 0n ? 'buy' : 'sell';                                   // base token leaves the pool = someone bought it
    const quoteAmt = Number(side === 'buy' ? qIn : qOut) / 10 ** p.quoteDecimals;
    let usd: number | null = null;
    if (p.quoteKind === 'stable') usd = quoteAmt; else if (p.quoteKind === 'native') { const px = await nativePrice(context, chain); usd = px === null ? null : quoteAmt * px; }
    if (bIn === 0n && bOut === 0n) return;                                     // no base movement (not a trade of the base token)
    await context.db.insert(trade).values({ id: `${chain}:${event.transaction.hash}:${event.log.logIndex}`, chain: chain === 'bnb' ? 'bnb' : chain, pool: address, side, wallet: event.transaction.from.toLowerCase(), usd, tx: event.transaction.hash, ts: Number(event.block.timestamp), block: event.block.number });
  });
}
