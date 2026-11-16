/** Solana: build a Raydium AMM v4 swap (swapBaseIn) as a legacy transaction and SIMULATE it. Nothing is signed or sent:
 *  the transaction carries an all-zero signature and is only passed to simulateTransaction with sigVerify:false.
 *  Instruction layout and account order: raydium-io/raydium-sdk-V2 src/raydium/liquidity/instruction.ts (makeSwapFixedInInstruction, version 4).
 *  Pool/market layouts: .../liquidity/layout.ts and .../serum/layout.ts. Authority derivations: .../liquidity/utils.ts and serum.ts. */
import { createHash } from 'node:crypto';
import { Rpc } from './rpc.ts';
import { SOL, SOL_POOL } from './config.ts';
import { base58, decodePoolState, quoteOut } from './solpool.ts';
import { cat, u64le, findProgramAddress, createProgramAddress, pubkeyBytes, ataAddress, createAtaIdempotent, systemTransfer, syncNative, compileLegacy, unsignedTx, raydiumSwapBaseIn, PROGRAMS } from '../../sol/src/tx.ts';
import type { PoolKeys } from '../../sol/src/tx.ts';
export * from '../../sol/src/tx.ts';
import type { Check } from './verify.ts';


// ---- layouts (offsets derived from the SDK layout files cited above; verified here against on-chain data by the checks that follow)
const POOL_OFF = { marketId: 528, marketProgramId: 560, targetOrders: 592 } as const;     // 496 (openOrders, already verified) + 32 each
const MKT = { size: 388, nonce: 45, baseMint: 53, quoteMint: 85, baseVault: 117, quoteVault: 165, eventQueue: 253, bids: 285, asks: 317 } as const;   // 5+8 pad, ownAddress@13
const pk = (d: Buffer, o: number) => base58(d.subarray(o, o + 32));

const ok = (id: string, detail: string): Check => ({ id, status: 'pass', detail });
const bad = (id: string, detail: string): Check => ({ id, status: 'fail', detail });

export interface SwapSim { checks: Check[]; slot?: number }
/** Simulate swapping `solIn` lamports of SOL for USDC on the SOL/USDC AMM v4 pool, for `owner` (a public address; no key needed). */
export async function simulateSolSwap(rpc: Rpc, owner: string, solIn = 10_000_000n): Promise<SwapSim> {
  const checks: Check[] = []; const guard = async (id: string, f: () => Promise<Check | Check[]>) => { try { const r = await f(); checks.push(...(Array.isArray(r) ? r : [r])); } catch (e) { checks.push(bad(id, (e as Error).message)); } };
  const slot = await rpc.call<number>('getSlot');
  const acct = async (a: string) => { const r: any = await rpc.call('getAccountInfo', [a, { encoding: 'base64' }]); return r?.value ? { owner: r.value.owner as string, exec: !!r.value.executable, lamports: BigInt(r.value.lamports), data: Buffer.from(r.value.data[0], 'base64') } : null; };
  const programId = SOL.programs[0].address;

  // 1. program ids we use must be real executables, and the token program must own the real USDC mint
  await guard('swap.programs', async () => {
    for (const [n, a] of Object.entries(PROGRAMS)) { const x = await acct(a); if (!x?.exec) throw new Error(`${n} program ${a} is missing or not executable`); }
    const mint = await acct(SOL_POOL.usdc.mint); if (mint?.owner !== PROGRAMS.token) throw new Error(`USDC mint owner is ${mint?.owner}, not the token program`);
    return ok('swap.programs', 'system, SPL token and associated-token programs exist and are executable; the SPL token program owns the official USDC mint');
  });
  await guard('swap.owner', async () => { const x = await acct(owner); if (!x) throw new Error(`owner ${owner} does not exist on-chain (unfunded)`); if (x.owner !== PROGRAMS.system) throw new Error(`owner is not a plain wallet (program ${x.owner})`);
    if (x.lamports < solIn + 10_000_000n) throw new Error(`owner holds ${x.lamports} lamports; need about ${solIn + 10_000_000n}`); return ok('swap.owner', `owner is a system account holding ${x.lamports} lamports`); });

  // 2. pool + market keys, read from chain and cross-checked
  const pool = await acct(SOL_POOL.id); if (!pool || pool.owner !== programId) return { checks: [...checks, bad('swap.pool', 'pool account missing or not owned by Raydium AMM v4')], slot };
  const st = decodePoolState(pool.data);
  const marketId = pk(pool.data, POOL_OFF.marketId), marketProgram = pk(pool.data, POOL_OFF.marketProgramId), targetOrders = pk(pool.data, POOL_OFF.targetOrders);
  const market = await acct(marketId);
  let keys: PoolKeys | undefined;
  await guard('swap.market', async () => {
    if (!market || market.owner !== marketProgram) throw new Error(`market ${marketId} is missing or not owned by market program ${marketProgram}`);
    if (market.data.length !== MKT.size) throw new Error(`market account is ${market.data.length} bytes, expected ${MKT.size}`);
    if (pk(market.data, MKT.baseMint) !== st.baseMint || pk(market.data, MKT.quoteMint) !== st.quoteMint) throw new Error('market mints do not match the pool mints (layout offsets wrong?)');
    const mProg = await acct(marketProgram); if (!mProg?.exec) throw new Error('market program is not executable');
    const nonce = market.data.readBigUInt64LE(MKT.nonce);
    const marketAuthority = createProgramAddress([pubkeyBytes(marketId), u64le(nonce)], marketProgram);
    const mbv = pk(market.data, MKT.baseVault), mqv = pk(market.data, MKT.quoteVault);
    const vault = await acct(mbv); if (vault?.data.length !== 165) throw new Error('market base vault is not a token account');
    const vOwner = base58(vault.data.subarray(32, 64)); if (vOwner !== marketAuthority) throw new Error(`market vault is owned by ${vOwner}, but the derived market authority is ${marketAuthority}`);
    const authority = findProgramAddress([new TextEncoder().encode('amm authority')], programId).address;
    const vA = await acct(st.baseVault); const vAOwner = base58(vA!.data.subarray(32, 64)); if (vAOwner !== authority) throw new Error(`pool vault is owned by ${vAOwner}, but the derived AMM authority is ${authority}`);
    keys = { programId, id: SOL_POOL.id, authority, openOrders: st.openOrders, targetOrders, baseVault: st.baseVault, quoteVault: st.quoteVault, marketProgram, market: marketId,
      bids: pk(market.data, MKT.bids), asks: pk(market.data, MKT.asks), eventQueue: pk(market.data, MKT.eventQueue), marketBaseVault: mbv, marketQuoteVault: mqv, marketAuthority };
    return ok('swap.market', `market ${marketId} decodes (mints match the pool); derived AMM authority ${authority} and market authority ${marketAuthority} each own the vaults they should (checked on-chain)`);
  });
  if (!keys) return { checks, slot };
  const K = keys;

  // 3. quote from vault balances, then simulate
  const bal = async (a: string) => { const r: any = await rpc.call('getAccountInfo', [a, { encoding: 'jsonParsed' }]); return BigInt(r.value.data.parsed.info.tokenAmount.amount); };
  const rBase = await bal(st.baseVault) - st.baseNeedTakePnl, rQuote = await bal(st.quoteVault) - st.quoteNeedTakePnl;
  const quote = quoteOut(solIn, rBase, rQuote, st.swapFeeNum, st.swapFeeDen);
  const wsolAta = ataAddress(owner, SOL_POOL.wsol.mint), usdcAta = ataAddress(owner, SOL_POOL.usdc.mint);
  const build = (minOut: bigint) => [createAtaIdempotent(owner, owner, SOL_POOL.wsol.mint), createAtaIdempotent(owner, owner, SOL_POOL.usdc.mint), systemTransfer(owner, wsolAta, solIn), syncNative(wsolAta), raydiumSwapBaseIn(K, wsolAta, usdcAta, owner, solIn, minOut)];
  const sim = async (minOut: bigint) => {
    const tx = Buffer.from(unsignedTx(compileLegacy(owner, build(minOut)))).toString('base64');
    const r: any = await rpc.call('simulateTransaction', [tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed', encoding: 'base64', accounts: { encoding: 'jsonParsed', addresses: [usdcAta] } }]);
    return r.value as { err: unknown; logs: string[]; unitsConsumed?: number; accounts?: any[] };
  };
  await guard('swap.sim.ok', async () => {
    const v = await sim(quote * 99n / 100n);
    if (v.err) throw new Error(`simulation failed: ${JSON.stringify(v.err)}; last log: ${v.logs?.slice(-2).join(' | ')}`);
    const out = BigInt(v.accounts?.[0]?.data?.parsed?.info?.tokenAmount?.amount ?? '0');
    const dev = quote === 0n ? 0 : Number((out > quote ? out - quote : quote - out) * 10_000n / quote);
    const res: Check[] = [ok('swap.sim.executes', `SOL -> USDC swap built by our code executes in simulation (${v.unitsConsumed} compute units); nothing signed or sent`)];
    res.push(dev <= 50 ? ok('swap.sim.output', `simulated USDC out ${out} vs our constant-product quote ${quote} (${dev} bps apart; tolerance 50: pool state moves between reads, open-orders balances are not in our quote)`) : bad('swap.sim.output', `simulated ${out} vs quote ${quote}: ${dev} bps apart`));
    return res;
  });
  await guard('swap.sim.minout', async () => {
    const v = await sim(quote * 2n);
    return v.err ? ok('swap.sim.minout', `minOut at 2x the quote is rejected by the program (${JSON.stringify(v.err)}): slippage protection works`) : bad('swap.sim.minout', 'a minOut at 2x the quote was accepted: slippage protection did not trigger');
  });
  return { checks, slot };
}
