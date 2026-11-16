/** VERIFY THE INDEXER ON A LOCAL FORK. Starts a local anvil fork of Ethereum mainnet (fake ETH, anvil's own unlocked dev accounts), makes real swaps on the real Uniswap V2 USDC/WETH pair of the fork,
 *  runs the Ponder indexer (indexer/) against that fork, and checks that what it serves matches the swaps we made and that the terminal's HttpTradeSource / FallbackTradeSource consume it.
 *  Nothing is sent to mainnet. usage: npm run verify:indexer (needs ALCHEMY_API_KEY in .env, and `npm install` inside indexer/). Writes a report to docs/live-verification/. */
import { spawn } from 'node:child_process';
import { createServer as net } from 'node:net';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { startFork } from './forkenv.ts';
import { encodeCall, decodeParams } from '../../evm/src/index.ts';
import { ETH } from './config.ts';
import { HttpTradeSource, FallbackTradeSource } from './indexport.ts';
import type { FeedToken, TradeSource } from './indexport.ts';
import type { Check } from './localrun.ts';

const freePort = () => new Promise<number>(r => { const s = net().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
const until = async <T>(f: () => Promise<T | undefined | false> | T | undefined | false, ms = 90000, label = 'condition') => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v as T; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`); await new Promise(r => setTimeout(r, 400)); } };

async function main() {
  const key = process.env.ALCHEMY_API_KEY; if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env and run again.'); process.exit(2); }
  if (!existsSync('indexer/node_modules/ponder')) { console.error('Run `npm install` inside indexer/ first.'); process.exit(2); }
  const checks: Check[] = [], facts: string[] = []; const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); };
  const forkPort = await freePort(), idxPort = await freePort(); const { node, redact, stop } = await startFork(key, forkPort);
  let child: ReturnType<typeof spawn> | undefined; let log = '';
  try {
    const router = ETH.uniswapV2Router02.address, factory = ETH.uniswapV2Factory.address, usdc = ETH.usdc.address.toLowerCase();
    const ethCall = async (to: string, data: string) => node.call<string>('eth_call', [{ to, data }, 'latest']);
    const weth = String(decodeParams(['address'], await ethCall(router, encodeCall('WETH()', [])))[0]).toLowerCase();
    const pair = String(decodeParams(['address'], await ethCall(factory, encodeCall('getPair(address,address)', [usdc, weth])))[0]).toLowerCase();
    check('I1 the USDC/WETH pair is read from the official factory on the fork (not typed in)', /^0x[0-9a-f]{40}$/.test(pair) && pair !== '0x' + '0'.repeat(40), `pair ${pair}`);
    const chainId = Number(BigInt(await node.call<string>('eth_chainId'))), accounts = await node.call<string[]>('eth_accounts');
    const [alice, bob] = accounts.map(a => a.toLowerCase());
    const send = async (from: string, to: string, data: string, value = 0n) => { const h = await node.call<string>('eth_sendTransaction', [{ from, to, data, value: '0x' + value.toString(16), gas: '0x7a120' }]); const r = await node.waitReceipt(h); if (r.status !== '0x1') throw new Error('transaction reverted'); return { hash: h as string, block: Number(BigInt(r.blockNumber)) }; };
    const dl = async () => BigInt((await node.call<any>('eth_getBlockByNumber', ['latest', false])).timestamp) + 3600n;
    const startBlock = Number(BigInt(await node.call<string>('eth_blockNumber')));
    const buy = async (from: string, eth: bigint) => send(from, router, encodeCall('swapExactETHForTokens(uint256,address[],address,uint256)', [0n, [weth, usdc], from, await dl()]), eth);
    const bal = async (who: string) => BigInt(await ethCall(usdc, encodeCall('balanceOf(address)', [who])));
    // swaps made BEFORE the indexer starts (it must catch up) and, later, while it runs
    const s1 = await buy(alice, 2n * 10n ** 18n), s2 = await buy(bob, 10n ** 18n);
    const MAX = (1n << 256n) - 1n; await send(alice, usdc, encodeCall('approve(address,uint256)', [router, MAX]));
    const sellAmt = (await bal(alice)) / 2n; const s3 = await send(alice, router, encodeCall('swapExactTokensForETH(uint256,uint256,address[],address,uint256)', [sellAmt, 0n, [usdc, weth], alice, await dl()]));
    facts.push(`fork chain id ${chainId}, indexing from block ${startBlock}; swaps made before the indexer started: buy 2 ETH (alice), buy 1 ETH (bob), sell ${sellAmt} USDC base units (alice)`);

    const env: Record<string, string> = { PATH: process.env.PATH!, HOME: process.env.HOME!, PORT: String(idxPort), DATABASE_SCHEMA: 'verify_' + Date.now(), INDEX_CHAINS: 'ethereum', INDEX_RPC_ETHEREUM: `http://127.0.0.1:${forkPort}`, INDEX_CHAIN_ID_ETHEREUM: String(chainId),
      INDEX_POOLS_ETHEREUM: pair, INDEX_START_BLOCK_ETHEREUM: String(startBlock), INDEX_STABLES_ETHEREUM: usdc, INDEX_WRAPPED_ETHEREUM: weth, INDEX_REF_POOL_ETHEREUM: pair };
    child = spawn('npx', ['ponder', 'start', '--port', String(idxPort)], { cwd: 'indexer', env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', d => { log += d; }); child.stderr!.on('data', d => { log += d; });
    const base = `http://127.0.0.1:${idxPort}`;
    const token: FeedToken = { id: 'usdc', sym: 'WETH', chain: 'ethereum', contract: weth, pool: pair, pad: null };
    const get = async (p: string) => (await fetch(base + p)).json() as Promise<any>;
    const rows = await until(async () => { try { const j = await get(`/trades?pools=${pair}`); return j.items.length >= 3 && j; } catch { return false; } }, 150000, 'the indexer to index the three swaps');
    check('I2 the indexer catches up on swaps made before it started: 3 trades served for the pair', rows.items.length === 3, `${rows.items.length} items`);
    const byTx = (h: string) => rows.items.find((x: any) => x.tx.toLowerCase() === h.toLowerCase());
    // side is of the BASE token. Here the quote is USDC (stable) and the base is WETH, so buying WETH = USDC in.
    const t1 = byTx(s1.hash), t2 = byTx(s2.hash), t3 = byTx(s3.hash);
    check('I3 each trade carries the real transaction sender (not the router) and the right side', !!t1 && !!t2 && !!t3 && t1.wallet === alice && t2.wallet === bob && t3.wallet === alice && t1.side === 'sell' && t3.side === 'buy', `sides ${t1?.side}/${t2?.side}/${t3?.side}; wallets ${t1?.wallet === alice}/${t2?.wallet === bob}/${t3?.wallet === alice}`);
    check('I4 USD values: the 2 ETH buy is about twice the 1 ETH buy, and all are positive', t1?.usd > 0 && Math.abs(t1.usd / t2.usd - 2) < 0.05, `usd ${t1?.usd?.toFixed(2)} / ${t2?.usd?.toFixed(2)} / ${t3?.usd?.toFixed(2)}`);
    const h = await get('/lag'); check('I5 /lag reports the lag in seconds', typeof h.lagS === 'number' && h.lagS >= 0 && h.lagS < 120, JSON.stringify(h));

    // the terminal's client
    const http = new HttpTradeSource(base); const r0 = await http.pollCycle([token]);
    check('I6 HttpTradeSource: the first poll is a silent baseline (3 trades kept, 0 announced)', r0.fresh.length === 0 && http.query().length === 3, `fresh ${r0.fresh.length}, kept ${http.query().length}`);
    await buy(bob, 5n * 10n ** 17n); const live = await until(async () => { const r = await http.pollCycle([token]); return r.fresh.length ? r : false; }, 60000, 'a live trade to reach the terminal client');
    check('I7 a swap made while the indexer is running is announced exactly once, as fresh', live.fresh.length === 1 && live.fresh[0].wallet === bob && live.fresh[0].fresh === true && (await http.pollCycle([token])).fresh.length === 0, `wallet ok ${live.fresh[0]?.wallet === bob}`);
    const third: TradeSource = { name: 'third', recent: [], errors: new Map(), lastFill: 0, loaded: 0, pollCycle: async () => ({ fresh: [], polled: 1, errors: 0 }), query: () => [], status: () => ({ name: 'third', serving: 'third', lastOkAt: 0, lastError: null }) };
    const fb = new FallbackTradeSource(new HttpTradeSource(base), third); await fb.pollCycle([token]);
    check('I8 FallbackTradeSource serves from our indexer while it is up', fb.status().serving === 'our indexer', fb.status().serving);
    child.kill(); await until(async () => { try { await fetch(base + '/lag'); return false; } catch { return true; } }, 20000, 'the indexer to stop'); await fb.pollCycle([token]);
    check('I9 with the indexer stopped, the next cycle is served by the third-party fallback and the reason is shown', fb.status().serving === 'third' && /unreachable|did not answer/.test(fb.status().lastError ?? ''), `${fb.status().serving}: ${fb.status().lastError}`);
    check('I10 the Alchemy key appears nowhere in the indexer output', !log.includes(key));
  } catch (e) { check('I0 the run completed without an error', false, redact((e as Error).message) + '\n' + redact(log).slice(-600)); }
  finally { child?.kill(); stop(); }
  const pass = checks.every(c => c.pass);
  const text = ['# Indexer on a local mainnet fork', '', `Run: ${new Date().toISOString()}`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${checks.filter(c => c.pass).length}/${checks.length} checks)`, '',
    'What this shows: the Ponder indexer in `indexer/` reads real Uniswap V2 swap events from a local anvil fork of Ethereum mainnet (fake ETH, anvil dev accounts), prices them in USD and serves them over the HTTP contract in `docs/INDEXER_CONTRACT.md`; the terminal client and fallback consume it.', '',
    '## Observed', ...facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/').replace(/\n/g, ' ')} |`), '',
    '## Not covered', '- Only the Uniswap V2 USDC/WETH pair on an Ethereum fork. BNB / PancakeSwap V2 uses the same event interface but was not run here.', '- A fork is not mainnet: no reorgs, one block per transaction, no mainnet-scale backfill speed or RPC cost.', '- USD values use the pair\'s own USDC side; pools quoted in WETH use the reference pool price and were not exercised here.'].join('\n');
  mkdirSync('docs/live-verification', { recursive: true }); const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-indexer-fork.md`; writeFileSync(file, redact(text));
  for (const c of checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + redact(c.detail)}`); console.log(`\nreport: ${file}`); process.exit(pass ? 0 : 1);
}
main();
