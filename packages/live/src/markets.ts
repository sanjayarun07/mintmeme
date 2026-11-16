/** READ-ONLY look at real coins on Ethereum (newest Uniswap V2 pairs, read on-chain) and Solana (top Raydium AMM v4 pools: listed by Raydium's public API, then confirmed on-chain).
 *  No key leaves the process except in the provider URL; only allowlisted read methods; nothing is signed or sent. Prints a table and writes a dated report. */
import { writeFileSync, mkdirSync } from 'node:fs';
import { Rpc } from './rpc.ts';
import { ETH, SOL, urls } from './config.ts';

const key = process.env.ALCHEMY_API_KEY; if (!key) { console.error('ALCHEMY_API_KEY is not set (put it in .env). Nothing was contacted.'); process.exit(1); }
const u = urls(key); const eth = new Rpc(u.eth, key), sol = new Rpc(u.sol, key);
const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
const call = (to: string, data: string) => eth.call<string>('eth_call', [{ to, data }, 'latest']);
const addr = (h: string) => '0x' + h.slice(-40);
function str(h: string) { const b = Buffer.from(h.slice(2), 'hex'); if (b.length === 32) return b.toString('utf8').replace(/\0+$/, ''); if (b.length >= 96) { const len = Number(BigInt('0x' + b.subarray(32, 64).toString('hex'))); return b.subarray(64, 64 + len).toString('utf8'); } return '?'; }
const sym = async (t: string) => { try { return str(await call(t, '0x95d89b41')); } catch { return '?'; } };
const dec = async (t: string) => { try { return Number(BigInt(await call(t, '0x313ce567'))); } catch { return 18; } };
const fmt = (n: bigint, d: number) => { const s = n.toString().padStart(d + 1, '0'); const w = s.slice(0, s.length - d), f = s.slice(s.length - d, s.length - d + 4); return Number(w).toLocaleString('en') + (d ? '.' + f : ''); };

const out: string[] = []; const say = (s = '') => { console.log(s); out.push(s); };
const chain = BigInt(await eth.call<string>('eth_chainId')); if (chain !== ETH.chainIdExpected) throw new Error(`unexpected chain id ${chain}`);
const block = BigInt(await eth.call<string>('eth_blockNumber'));
say(`# Real coins, read-only (${new Date().toISOString()})\n\n## Ethereum mainnet, block ${block}: newest Uniswap V2 pairs (read on-chain from the official factory)\n`);
const n = BigInt(await call(ETH.uniswapV2Factory.address, '0x574f2ba3'));
say(`Factory lists ${n} pairs. Newest 8:\n\n| Pair | Token 0 | Token 1 | Reserve 0 | Reserve 1 |\n|---|---|---|---|---|`);
for (let i = n - 1n; i > n - 9n; i--) {
  const pair = addr(await call(ETH.uniswapV2Factory.address, '0x1e3dd18b' + word(i)));
  const t0 = addr(await call(pair, '0x0dfe1681')), t1 = addr(await call(pair, '0xd21220a7')); const r = await call(pair, '0x0902f1ac');
  const r0 = BigInt('0x' + r.slice(2, 66)), r1 = BigInt('0x' + r.slice(66, 130));
  const [s0, s1, d0, d1] = [await sym(t0), await sym(t1), await dec(t0), await dec(t1)];
  say(`| ${pair.slice(0, 10)}… | ${s0} (${t0.slice(0, 8)}…) | ${s1} (${t1.slice(0, 8)}…) | ${fmt(r0, d0)} | ${fmt(r1, d1)} |`);
}
say('\nSymbols come from the token contracts themselves and anyone can name a token anything: a name here is not an identity. New pairs are mostly junk or scams; this is a view, not a recommendation.');

say(`\n## Solana mainnet, slot ${await sol.call('getSlot')}: top Raydium AMM v4 pools by liquidity (listed by api-v3.raydium.io, confirmed on-chain)\n`);
const prog = SOL.programs[0].address;
const api: any = await (await fetch('https://api-v3.raydium.io/pools/info/list?poolType=standard&poolSortField=liquidity&sortType=desc&pageSize=8&page=1')).json();
say('| Pool | Pair | Liquidity (USD) | 24h volume (USD) | On-chain owner is Raydium AMM v4 |\n|---|---|---|---|---|');
for (const p of api.data?.data ?? []) {
  const acc: any = await sol.call('getAccountInfo', [p.id, { encoding: 'base64' }]);
  const ok = acc?.value?.owner === prog && acc.value.space === 752;
  say(`| ${p.id.slice(0, 8)}… | ${p.mintA.symbol}/${p.mintB.symbol} | ${Math.round(p.tvl).toLocaleString('en')} | ${Math.round(p.day?.volume ?? 0).toLocaleString('en')} | ${ok ? 'yes' : 'NO'} |`);
}
say('\nLiquidity and volume figures are Raydium API data (not independently verified); the owner/size check is ours, on-chain. Read-only: nothing signed, nothing sent.');
mkdirSync('docs/live-verification', { recursive: true });
writeFileSync(`docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-mainnet-markets.md`, out.join('\n') + '\n');
