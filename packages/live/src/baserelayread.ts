/** COINBASE STOCKS ON BASE THROUGH RELAY, READ-ONLY CHECK AGAINST MAINNET STATE. For each Coinbase stock token (base.org/stocks): the real EvmRpcChain with the real
 *  RelayClient adds Relay venues, then SIMULATES a 0.002 ETH buy exactly as a trade would be built (Relay quote at our slippage, gateRelay, the 0x registry check,
 *  eth_simulateV1 against the wallet's balances). Nothing is signed or sent: the RPC wrapper refuses eth_sendRawTransaction and the signer refuses everything.
 *  The simulation needs a wallet with ETH, so a busy public Base wallet is the read-only "taker" (BASE_SIM_TAKER overrides it).
 *  usage: npm run verify:base-relay   (BASE_RPC_URL optional, default https://mainnet.base.org; RELAY_API_KEY optional). Writes a report to docs/live-verification/. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { NATIVE } from '../../core/src/index.ts';
import { EvmRpcChain, RelayClient, RELAY_BASE } from '../../evm/src/index.ts';
import { BASE_STOCKS } from '../../evm/src/basestocks.ts';
import { EvmJsonRpc, BASE } from '../../sdk/src/base.ts';

const url = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org', inner = new EvmJsonRpc(url), TAKER = (process.env.BASE_SIM_TAKER ?? '0x43f3c1c1da83dd6a541a98a7914e3791e39aac85').toLowerCase();
const rpc = { call: async <T = any>(m: string, p: unknown[] = []): Promise<T> => { if (m === 'eth_sendRawTransaction') throw new Error('read-only: sending is refused'); return inner.call<T>(m, p); } };
const STOCKS = BASE_STOCKS;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms)), AMT = 2_000_000_000_000_000n, rows: string[] = [], results: Record<string, string> = {};
const chain = new EvmRpcChain({ id: 'base-read', chainId: BASE.chainId, router: BASE.router, weth: BASE.weth, pools: [], relay: { client: new RelayClient({ chainId: 8453, apiKey: process.env.RELAY_API_KEY }), contracts: RELAY_BASE, refWallet: TAKER } },
  rpc, { sign: () => { throw new Error('read-only: signing is refused'); } });
await chain.refresh('head');
for (const [sym, addr] of Object.entries(STOCKS)) {
  const t = addr.toLowerCase(); let line = '';
  for (let attempt = 1; attempt <= 3; attempt++) {   // Relay picks the inner route per quote; a route through an unreviewed contract is refused, so ask again
    try {
      if (!(await chain.addAggToken(t, AMT))) { line = `no Relay route (${chain.aggError})`; break; }
      const v = chain.venues().find(x => x.supports(NATIVE, t))!, est = v.quote(NATIVE, t, AMT).amountOut;
      const sim = await chain.simulate({ hash: '', wallet: TAKER, nonce: 0, venue: v.id, tokenIn: NATIVE, tokenOut: t, amountIn: AMT, minOut: est * 98n / 100n, deadline: chain.time + 600, platformFeeBps: 0 });
      line = sim.receipt.status === 'success' ? `ok: simulated ${sim.receipt.deltas[t]} raw out (reference ${est})${attempt > 1 ? `, on attempt ${attempt}` : ''}` : `refused: ${sim.receipt.reason}`;
      if (sim.receipt.status === 'success' || !/not reviewed|not a reviewed/.test(sim.receipt.reason ?? '')) break;
    } catch (e) { line = `error: ${(e as Error).message.slice(0, 160)}`; }
    await sleep(2000);
  }
  results[sym] = line; rows.push(`- **${sym}** \`${addr}\`: ${line}`); console.log(sym, line); await sleep(1500);
}
const ok = Object.values(results).filter(x => x.startsWith('ok')).length, at = new Date().toISOString();
const body = `# Coinbase stocks on Base through Relay: read-only mainnet check (${at})\n\nRPC: ${url}. Simulation taker: \`${TAKER}\` (read-only; nothing signed or sent). Buy size 0.002 ETH, minimum 98% of the reference quote.\n\n${rows.join('\n')}\n\nResult: ${ok} of ${Object.keys(STOCKS).length} simulated buys passed the gate and the balance check.\n`;
mkdirSync('docs/live-verification', { recursive: true }); writeFileSync(`docs/live-verification/${at.replace(/[:.]/g, '-')}-base-relay.md`, body); console.log(`\n${ok} of ${Object.keys(STOCKS).length} ok`);
