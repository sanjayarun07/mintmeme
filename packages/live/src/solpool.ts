import { Rpc } from './rpc.ts';
import { base58 } from '../../sol/src/tx.ts';
import { SOL, SOL_POOL, AMM_V4_LAYOUT as L } from './config.ts';
import type { Check } from './verify.ts';

const ok = (id: string, detail: string): Check => ({ id, status: 'pass', detail });
const bad = (id: string, detail: string): Check => ({ id, status: 'fail', detail });
export { base58 };
export { decodePoolState, quoteOut } from '../../sol/src/raydium.ts';
import { decodePoolState, quoteOut } from '../../sol/src/raydium.ts';
import type { PoolState } from '../../sol/src/raydium.ts';
export type { PoolState };
const TOL_BPS = 100n;   // 1%: benchmark is Raydium's own service at a slightly different moment, and its route can differ

export async function verifySolanaPool(rpc: Rpc, fetchFn: typeof fetch = fetch): Promise<{ checks: Check[]; slot?: number }> {
  const checks: Check[] = []; let slot: number | undefined;
  const guard = async (id: string, f: () => Promise<Check>) => { try { checks.push(await f()); } catch (e) { checks.push(bad(id, (e as Error).message)); } };
  slot = await rpc.call<number>('getSlot');
  let st: PoolState | undefined;
  await guard('pool.account', async () => {
    const r: any = await rpc.call('getAccountInfo', [SOL_POOL.id, { encoding: 'base64' }]);
    if (!r?.value) return bad('pool.account', `pool account ${SOL_POOL.id} does not exist`);
    if (r.value.owner !== SOL.programs[0].address) return bad('pool.account', `owner is ${r.value.owner}, expected Raydium AMM v4 ${SOL.programs[0].address}`);
    st = decodePoolState(Buffer.from(r.value.data[0], 'base64'));
    return ok('pool.account', `owned by Raydium AMM v4, ${L.size} bytes, decoded at slot ${slot}; status ${st.status}, fee ${st.swapFeeNum}/${st.swapFeeDen}`);
  });
  if (!st) return { checks, slot };
  const s = st;
  await guard('pool.mints', async () => s.baseMint === SOL_POOL.wsol.mint && s.quoteMint === SOL_POOL.usdc.mint && s.baseDecimal === 9 && s.quoteDecimal === 6
    ? ok('pool.mints', `base = Wrapped SOL (9 decimals), quote = USDC (6 decimals), both matching their official sources`) : bad('pool.mints', `base ${s.baseMint}/${s.baseDecimal}, quote ${s.quoteMint}/${s.quoteDecimal}`));
  let baseBal = 0n, quoteBal = 0n;
  const vault = async (id: string, addr: string, mint: string) => {
    const r: any = await rpc.call('getAccountInfo', [addr, { encoding: 'jsonParsed' }]); const info = r?.value?.data?.parsed?.info;
    if (!info) throw new Error(`vault ${addr} is not a parsed token account`); if (info.mint !== mint) throw new Error(`vault ${addr} holds mint ${info.mint}, expected ${mint}`);
    return BigInt(info.tokenAmount.amount);
  };
  await guard('pool.vaults', async () => { baseBal = await vault('base', s.baseVault, s.baseMint); quoteBal = await vault('quote', s.quoteVault, s.quoteMint); return ok('pool.vaults', `vault balances ${baseBal} base units / ${quoteBal} quote units; each vault holds the pool's declared mint`); });
  const rBase = baseBal - s.baseNeedTakePnl, rQuote = quoteBal - s.quoteNeedTakePnl;   // open-orders balances are not added (layout not sourced): see note
  const price = Number(rQuote) / 10 ** s.quoteDecimal / (Number(rBase) / 10 ** s.baseDecimal);
  await guard('pool.reserves', async () => rBase > 0n && rQuote > 0n ? ok('pool.reserves', `effective reserves ${rBase} / ${rQuote} (vault minus pending protocol take); implied price ${price.toFixed(4)} USDC per SOL. Open-orders balances are NOT included.`) : bad('pool.reserves', 'empty effective reserves'));
  // Independent benchmark: Raydium's own API (a service, not ground truth).
  await guard('pool.price.vs-raydium-api', async () => {
    const j: any = await (await fetchFn(`${SOL_POOL.benchmarkPoolInfo}?ids=${SOL_POOL.id}`)).json(); const apiPrice = Number(j?.data?.[0]?.price);
    if (!(apiPrice > 0)) throw new Error('benchmark API returned no price'); const dev = Math.abs(price - apiPrice) / apiPrice * 10_000;
    return dev <= Number(TOL_BPS) ? ok('pool.price.vs-raydium-api', `on-chain implied ${price.toFixed(4)} vs Raydium API ${apiPrice.toFixed(4)}: ${dev.toFixed(1)} bps apart (tolerance ${TOL_BPS})`) : bad('pool.price.vs-raydium-api', `${dev.toFixed(1)} bps apart (on-chain ${price.toFixed(4)}, API ${apiPrice.toFixed(4)}); investigate (open-orders balance, stale API, wrong pool)`);
  });
  await guard('pool.quote.vs-raydium-api', async () => {
    const IN = 1_000_000_000n; const ours = quoteOut(IN, rBase, rQuote, s.swapFeeNum, s.swapFeeDen);
    const j: any = await (await fetchFn(`${SOL_POOL.benchmarkQuote}?inputMint=${SOL_POOL.wsol.mint}&outputMint=${SOL_POOL.usdc.mint}&amount=${IN}&slippageBps=50&txVersion=V0`)).json();
    if (!j?.success) throw new Error('benchmark quote API did not succeed'); const theirs = BigInt(j.data.outputAmount); const dev = (ours > theirs ? ours - theirs : theirs - ours) * 10_000n / theirs;
    return dev <= TOL_BPS ? ok('pool.quote.vs-raydium-api', `1 SOL -> ours ${ours} vs Raydium API ${theirs} USDC units (${dev} bps apart). Their route may use a different pool (benchmark only, not execution).`) : bad('pool.quote.vs-raydium-api', `ours ${ours} vs API ${theirs}: ${dev} bps apart`);
  });
  checks.push({ id: 'pool.swap-instruction', status: 'skipped', detail: 'Building and simulating a real Raydium swap instruction (accounts, open-orders, simulateTransaction) is not done yet; this run proves reads and pricing only.' });
  return { checks, slot };
}
