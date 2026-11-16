/** READ-ONLY token detail: dev info, holder concentration, mint/ownership powers and recent trades. Nothing is signed or sent.
 *  Sources, and how far each is trusted:
 *   - On-chain via our own RPC reads (authoritative for what they read): Pump.fun creator (BondingCurve account, IDL field order), mint and freeze authority, top token accounts and their owners,
 *     ERC-20 owner() / balanceOf. A token without owner() simply has no owner entry; that is not proof of safety.
 *   - Trades: GeckoTerminal's public API (THIRD PARTY, rate limited, last ~300 trades of a DEX pool). Wallet addresses are the transaction senders it reports; we do not re-verify each trade.
 *  Not read (and said so in `notes`): dev's other launches, dev sells, EVM holder lists (needs an indexer), tokens still on a curve have no DEX pool feed. */
import { Rpc } from './rpc.ts';
import { readPumpCurve, bondingCurveAddress, PAD } from './launchpads.ts';
import { findProgramAddress, pubkeyBytes, PROGRAMS } from '../../sol/src/tx.ts';

export interface Trade { t: string; side: 'buy' | 'sell'; wallet: string; usd: number; tx: string }
export interface Holder { account: string; owner: string | null; pct: number; label: string | null }
export interface TokenInfo {
  chain: 'ethereum' | 'bnb' | 'solana'; contract: string; at: number; notes: string[];
  dev: { creator: string | null; creatorHoldPct: number | null; owner: string | null; renounced: boolean | null; mintAuthority: string | null; freezeAuthority: string | null; mintable: boolean | null };
  holders: { top: Holder[]; top10Pct: number; top10ExCurvePct: number | null; supply: string; decimals: number } | null;
  trades: { items: Trade[]; largest: Trade[]; whaleUsd: number; buys: number; sells: number; buyUsd: number; sellUsd: number; uniqueBuyers: number; uniqueSellers: number; topBuyers: { wallet: string; usd: number; n: number }[]; source: string; error?: string } | null;
}
export interface InfoDeps { rpc: { ethereum: Rpc; bsc: Rpc; sol: Rpc }; fetchFn?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void> }
export interface TokenRef { chain: 'ethereum' | 'bnb' | 'solana'; contract: string; pool: string; pad: string | null }
const NET = { ethereum: 'eth', bnb: 'bsc', solana: 'solana' } as const;
const WHALE_USD = 5000;
const zeroAddr = (a: string) => /^0x0+$/.test(a);
const word = (h: string) => h.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const pct2 = (n: bigint, d: bigint) => d > 0n ? Number(n * 10000n / d) / 100 : 0;

/** GeckoTerminal allows about 30 calls a minute: calls are spaced one every 2.2 s across the whole process. */
let next = 0;
async function gecko(url: string, d: InfoDeps): Promise<any> {
  const now = (d.now ?? Date.now)(); const wait = Math.max(0, next - now); next = now + wait + 2200; if (wait) await (d.sleep ?? (ms => new Promise(r => setTimeout(r, ms))))(wait);
  const r = await (d.fetchFn ?? fetch)(url, { headers: { accept: 'application/json;version=20230302' } });
  if (r.status === 404) throw new Error('This pool has no trade feed (tokens still on a launchpad curve are not on a DEX pool yet).');
  if (r.status === 429) throw new Error('The trade feed is rate limited right now. Try again in a minute.');
  if (!r.ok) throw new Error(`The trade feed answered HTTP ${r.status}.`);
  return r.json();
}
export async function loadTrades(t: TokenRef, d: InfoDeps, whaleUsd = WHALE_USD): Promise<NonNullable<TokenInfo['trades']>> {
  const source = 'GeckoTerminal public API (third party; last ~300 trades of the pool; sender addresses as reported)';
  const j = await gecko(`https://api.geckoterminal.com/api/v2/networks/${NET[t.chain]}/pools/${t.pool}/trades`, d);
  const all: Trade[] = (j.data ?? []).map((x: any) => x.attributes).filter((a: any) => a && (a.kind === 'buy' || a.kind === 'sell')).map((a: any) => ({ t: a.block_timestamp, side: a.kind, wallet: a.tx_from_address, usd: Number(a.volume_in_usd) || 0, tx: a.tx_hash }));
  const buys = all.filter(x => x.side === 'buy'), sells = all.filter(x => x.side === 'sell');
  const per = new Map<string, { usd: number; n: number }>(); for (const b of buys) { const e = per.get(b.wallet) ?? { usd: 0, n: 0 }; e.usd += b.usd; e.n++; per.set(b.wallet, e); }
  return { items: all.slice(0, 40), largest: [...all].sort((a, b) => b.usd - a.usd).slice(0, 5), whaleUsd, buys: buys.length, sells: sells.length, buyUsd: buys.reduce((s, x) => s + x.usd, 0), sellUsd: sells.reduce((s, x) => s + x.usd, 0),
    uniqueBuyers: new Set(buys.map(x => x.wallet)).size, uniqueSellers: new Set(sells.map(x => x.wallet)).size, topBuyers: [...per].map(([wallet, v]) => ({ wallet, ...v })).sort((a, b) => b.usd - a.usd).slice(0, 5), source };
}

async function solana(t: TokenRef, d: InfoDeps, notes: string[]): Promise<Pick<TokenInfo, 'dev' | 'holders'>> {
  const sol = d.rpc.sol; const dev: TokenInfo['dev'] = { creator: null, creatorHoldPct: null, owner: null, renounced: null, mintAuthority: null, freezeAuthority: null, mintable: null };
  const mint: any = await sol.call('getAccountInfo', [t.contract, { encoding: 'jsonParsed' }]); const mi = mint?.value?.data?.parsed?.info;
  if (!mi) { notes.push('The mint account could not be read as a token mint.'); return { dev, holders: null }; }
  const decimals = Number(mi.decimals), supply = BigInt(mi.supply), tokenProgram: string = mint.value.owner;
  dev.mintAuthority = mi.mintAuthority ?? null; dev.freezeAuthority = mi.freezeAuthority ?? null; dev.mintable = mi.mintAuthority != null; dev.renounced = mi.mintAuthority == null;
  let curveAddr: string | null = null;
  if (t.pad === 'pump-fun') { curveAddr = bondingCurveAddress(t.contract); const c = await readPumpCurve(sol, t.contract); dev.creator = c?.creator ?? null; if (!c?.creator) notes.push('The Pump.fun curve account did not include a creator field.'); }
  else notes.push('The creator is only read for Pump.fun tokens. Mint authority shows who can create more supply.');
  if (dev.creator) {   // dev balance = the creator's associated token account for this mint (derived with the mint's own token program id)
    try { const ata = findProgramAddress([pubkeyBytes(dev.creator), pubkeyBytes(tokenProgram), pubkeyBytes(t.contract)], PROGRAMS.ata).address; const b: any = await sol.call('getTokenAccountBalance', [ata]); dev.creatorHoldPct = pct2(BigInt(b.value.amount), supply); }
    catch { dev.creatorHoldPct = 0; notes.push('The creator has no token account for this mint (holds 0, or sold everything and closed it).'); }
  }
  let holders: TokenInfo['holders'] = null;
  try {
    const r: any = await sol.call('getTokenLargestAccounts', [t.contract]); const top: Holder[] = []; let curveHeld = 0n, topSum = 0n, exCurve = 0n;
    for (const row of (r.value ?? []).slice(0, 10)) {
      const a: any = await sol.call('getAccountInfo', [row.address, { encoding: 'jsonParsed' }]); const owner: string | null = a?.value?.data?.parsed?.info?.owner ?? null; const amt = BigInt(row.amount);
      const label = owner && owner === curveAddr ? 'Pump.fun bonding curve' : owner && owner === dev.creator ? 'Creator (dev)' : null;
      top.push({ account: row.address, owner, pct: pct2(amt, supply), label }); topSum += amt; if (label === 'Pump.fun bonding curve') curveHeld += amt; else exCurve += amt;
    }
    holders = { top, top10Pct: pct2(topSum, supply), top10ExCurvePct: curveHeld > 0n ? pct2(exCurve, supply - curveHeld) : null, supply: supply.toString(), decimals };
  } catch (e) { notes.push(`Holders could not be read: ${(e as Error).message}`); }
  return { dev, holders };
}
async function evm(t: TokenRef, d: InfoDeps, notes: string[]): Promise<Pick<TokenInfo, 'dev' | 'holders'>> {
  const rpc = t.chain === 'ethereum' ? d.rpc.ethereum : d.rpc.bsc; const dev: TokenInfo['dev'] = { creator: null, creatorHoldPct: null, owner: null, renounced: null, mintAuthority: null, freezeAuthority: null, mintable: null };
  try { const r = await rpc.call<string>('eth_call', [{ to: t.contract, data: '0x8da5cb5b' }, 'latest']); const o = '0x' + r.slice(-40); dev.owner = zeroAddr(o) ? null : o; dev.renounced = zeroAddr(o); }
  catch { notes.push('This token has no owner() function: no single owner address to show. That is not proof the contract is safe.'); }
  if (dev.owner) { try { const sup = BigInt(await rpc.call<string>('eth_call', [{ to: t.contract, data: '0x18160ddd' }, 'latest'])); const b = BigInt(await rpc.call<string>('eth_call', [{ to: t.contract, data: '0x70a08231' + word(dev.owner) }, 'latest'])); dev.creatorHoldPct = pct2(b, sup); notes.push('"Creator hold" for this token is the OWNER address balance, which may differ from the deployer.'); } catch { /* balance unreadable */ } }
  notes.push(t.chain === 'ethereum' ? 'Top-holder lists on Ethereum need an indexer and are not read here.' : 'Top-holder lists on BNB Smart Chain need an indexer and are not read here.');
  return { dev, holders: null };
}
export async function loadTokenInfo(t: TokenRef, d: InfoDeps): Promise<TokenInfo> {
  const notes: string[] = []; const base = t.chain === 'solana' ? await solana(t, d, notes) : await evm(t, d, notes);
  let trades: TokenInfo['trades'] = null;
  if (t.pool && t.pool.toLowerCase() !== PAD.fourMeme.tokenManager2.toLowerCase()) { try { trades = await loadTrades(t, d); } catch (e) { notes.push((e as Error).message); } }
  else notes.push('No DEX pool trade feed: the token is still on its launchpad curve. Curve trades are not read yet.');
  notes.push('Dev history (their other launches and any sells) is not read.');
  return { chain: t.chain, contract: t.contract, at: (d.now ?? Date.now)(), notes, ...base, trades };
}
