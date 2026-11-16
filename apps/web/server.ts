import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { world } from '../../packages/core/test/fixtures.ts';
import { CpAmm, NATIVE, analyze, extract, Reservations, OrderManager, CopyEngine, Portfolio, PriceAlerts, simulateLaunch, defaultTierConfig, enforce, TwapRunner, BulkRunner, splitEqual } from '../../packages/core/src/index.ts';
import { explain, makeTxView } from './common.ts';
import type { Order, CopyConfig, Intent } from '../../packages/core/src/index.ts';

// Everything here runs on a LOCAL SIMULATED CHAIN with fixture pools. The UI says so on every screen.
const E18 = 10n ** 18n;
const w = world({ dailyLimit: 5_000_000n });
const { chain, engine, store, signer, policies } = w;
const USER = 'u1';
const TOKENS: Record<string, { sym: string; name: string; blurb: string; venue: string }> = {
  '0xMEME': { sym: 'MEME', name: 'Meme Coin', blurb: 'Healthy fixture pool: no tax, sells work.', venue: 'uni-v2:MEME' },
  '0xTAX': { sym: 'TAXY', name: 'Taxy Token', blurb: 'Takes 10% on every buy and sell.', venue: 'uni-v2:TAX' },
  '0xHONEY': { sym: 'HONEY', name: 'Honey Pot', blurb: 'Buying works, selling is blocked.', venue: 'uni-v2:HONEY' },
  '0xFRESH': { sym: 'FRESH', name: 'Fresh Launch', blurb: 'Trading is not open yet.', venue: 'uni-v2:FRESH' },
};
chain.addVenue(new CpAmm('uni-v2:FRESH', 'uniswap-v2', '0xFRESH', NATIVE, 1_000_000n, 1_000_000n));
chain.tokens.set('0xFRESH', { tradingOpenBlock: chain.block + 12 });
// Practice tokens get realistic-looking contract addresses so pasted messages can be recognised.
const CONTRACT: Record<string, string> = { '0xMEME': '0x' + 'a1'.repeat(20), '0xTAX': '0x' + 'b2'.repeat(20), '0xHONEY': '0x' + 'c3'.repeat(20), '0xFRESH': '0x' + 'd4'.repeat(20) };
const BY_CONTRACT = Object.fromEntries(Object.entries(CONTRACT).map(([k, v]) => [v.toLowerCase(), k]));
const WALLETS: Record<string, string> = { w1: 'Main wallet', w2: 'Second wallet' };
chain.credit('w2', '0xMEME', 0n);

// ---------- notifications ----------
type Level = 'success' | 'info' | 'warn' | 'error';
const notes: { id: number; level: Level; title: string; body: string; ts: number }[] = [];
const note = (level: Level, title: string, body: string) => notes.push({ id: notes.length + 1, level, title, body, ts: Date.now() });

const meme = () => chain.state.venues.get('uni-v2:MEME') as CpAmm;
const poolOf = (token: string) => chain.state.venues.get(TOKENS[token].venue) as CpAmm;
const priceOf = (token: string) => { const p = poolOf(token); return Number(p.rQuote) / Number(p.rToken); };
const priceE18 = (token: string) => { const p = poolOf(token); return p.rQuote * E18 / p.rToken; };
const toE18 = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const ser = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));

const txView = makeTxView(t => TOKENS[t]?.sym);

// ---------- strategy engines (shared with the same engine as manual trades) ----------
const res = new Reservations((wl, t) => chain.balance(wl, t));
let entriesPaused = false;   // global "Pause new automated entries": blocks automated BUYS only; exits, manual trades and open orders' reservations are untouched
const submitIntent = (i: Intent) => {
  if (entriesPaused && i.origin !== 'manual' && i.tokenIn === NATIVE) {
    note('warn', 'Automated buy skipped', 'New automated entries are paused, so this buy was not sent. Exits and manual trades are unaffected.');
    if (i.origin === 'order') { const id = i.idempotencyKey.split(':')[1]; try { orders.onResult(id, false); } catch { /* order already gone */ } }
    return;
  }
  engine.submit(i).then(r => { if (r.state === 'failed') note('error', explain(r.failure).title, explain(r.failure).why + ' ' + explain(r.failure).fix); }); };
const orders: OrderManager = new OrderManager(res, (i) => submitIntent(i), () => chain.time, () => Date.now());
// TWAP orders (time-weighted): one wallet trades a token in equal slices over time. Each slice is an ordinary engine intent from the same wallet and policy.
import { bulkView, pctToBps } from './bulkview.ts';
import { LinkStore } from '../telegram/linking.ts';
import type { Ctx as TgCtx } from '../telegram/handler.ts';
const bulks = new Map<string, BulkRunner>(); const bulkSeen = new Map<string, string>();
const twaps = new Map<string, TwapRunner>(); const twapSeen = new Map<string, string>();
const copyCfg: CopyConfig = { follower: 'me', walletId: 'w1', userId: USER, leader: 'whale.sim', chain: 'sim-evm', quoteToken: NATIVE, mode: 'proportional', fixed: 5000n, ratioBps: 2000, sides: 'both',
  maxPerLeader: 60_000n, maxPerToken: 40_000n, dailyLimit: 120_000n, maxPositions: 3, cooldownS: 0, minLiquidity: 10_000n, maxDeviationBps: 1500, minConfirmations: 1, followLeaderExit: true, slippageBps: 500, venues: ['uniswap-v2'] };
let copyOn = false, leaderBal = 0n, evN = 0;
const copy = new CopyEngine([copyCfg], (_c, t) => ({ priceE18: priceE18(t), liquidity: poolOf(t).rQuote }), submitIntent, () => chain.time);
const portfolio = new Portfolio();
const alerts = new PriceAlerts();
const alertList: { id: string; token: string; direction: 'above' | 'below'; threshold: number; fired?: number }[] = [];
const cfgTier = defaultTierConfig(); let tier = 'free';
const seenSignals = new Set<string>();
const lastState = new Map<string, string>(); const booked = new Set<string>(); const orderDone = new Set<string>(); const copyDone = new Set<string>();

/** Budget in use and unrealised result of positions bought because of the leader (read-only views of engine state). */
function copyStats() {
  try {
    const used = copy.exposure('me', 'whale.sim'); let value = 0n;
    for (const t of Object.keys(TOKENS)) { const q = copy.attributed('me', 'whale.sim', t); if (q > 0n) value += q * priceE18(t) / E18; }
    return { budgetUsed: used, openValue: value, unrealised: value - used, lastAction: copy.log.length ? copy.log[copy.log.length - 1].decision : null };
  } catch { return { budgetUsed: 0n, openValue: 0n, unrealised: 0n, lastAction: null }; }
}
function friendlySkip(d: string) {
  const s = d.replace('skip: ', '');
  const m: Record<string, string> = { 'duplicate across providers': 'Already handled (the same trade arrived twice).', 'liquidity below minimum': 'Skipped: the pool is smaller than your minimum liquidity.', 'price moved beyond deviation limit': 'Skipped: the price has moved too far from the leader’s price.',
    'cooldown': 'Skipped: waiting for the cooldown between copies.', 'allocation/daily limit exhausted': 'Skipped: your allocation or daily limit is used up.', 'max concurrent positions': 'Skipped: you already hold the maximum number of copied tokens.',
    'side disabled': 'Skipped: this trade direction is switched off in your settings.', 'token filtered': 'Skipped: this token is blocked by your filters.' };
  if (s.startsWith('not an economic swap')) return 'Ignored: this was a transfer, not a swap.';
  if (s.startsWith('no leader-attributed')) return 'Ignored: you hold none of this token from copying this leader, so your other holdings are untouched.';
  if (s.startsWith('needs')) return 'Waiting for more network confirmations before copying.';
  if (s === 'reorged out') return 'Ignored: the leader’s trade was removed from the chain.';
  return m[s] ?? s;
}

/** After any block: advance all transactions, then react to what changed. */
async function settle() {
  for (const k of [...store.records.keys()]) await engine.advance(k);
  for (const r of store.records.values()) {
    const prev = lastState.get(r.key); lastState.set(r.key, r.state);
    if (r.key.startsWith('mm-')) continue;   // demo price-mover trades: no messages, not part of your portfolio
    const v = txView(r);
    if (prev !== r.state) {
      if (r.state === 'confirmed' && r.fill) note('success', v.headline.replace(' confirmed, waiting for final', '') + ' confirmed', `Received ${r.fill.received}${v.side === 'buy' ? ' ' + v.sym : ' SIM'} for ${r.fill.spent}. Fees: platform ${r.fill.platformFee}, pool ${r.fill.venueFee}, network ${r.fill.networkFee}. Final after a few more blocks.`);
      if (r.state === 'finalized') note('info', `${v.sym} ${v.side} is final`, 'Enough blocks have passed that this trade can no longer be reversed.');
      if (r.state === 'failed' || r.state === 'expired') { const e = v.explain!; if (r.intent.origin !== 'manual' || r.history.some(h => h.note?.startsWith('reverted'))) note('error', `${e.title}`, `${e.why} ${e.fix}`); }
    }
    if ((r.state === 'confirmed' || r.state === 'finalized') && r.fill && !booked.has(r.key)) {
      booked.add(r.key);
      portfolio.recordTrade({ id: r.key, userId: USER, chain: 'sim-evm', tokenIn: r.intent.tokenIn, tokenOut: r.intent.tokenOut, venue: r.quote!.venue, state: r.state, fill: r.fill, ts: chain.time, origin: r.intent.origin });
    }
    if (r.intent.origin === 'copy' && (r.state === 'confirmed' || r.state === 'finalized') && r.fill && !copyDone.has(r.key)) {
      copyDone.add(r.key); const buy = r.intent.tokenIn === NATIVE;
      copy.recordFill(copyCfg, buy ? r.intent.tokenOut : r.intent.tokenIn, buy ? 'buy' : 'sell', buy ? r.fill.received : r.fill.spent, buy ? r.fill.spent : r.fill.received);
    }
    if (r.intent.origin === 'order' && ['confirmed', 'finalized', 'failed', 'expired'].includes(r.state) && !orderDone.has(r.key)) {
      orderDone.add(r.key); const id = r.key.split(':')[1]; const ok = r.state === 'confirmed' || r.state === 'finalized';
      if (orders.orders.has(id)) { orders.onResult(id, ok); }
    }
  }
  // order triggers use a fresh snapshot and an executable quote
  const fired = orders.tick(o => { const p = poolOf(o.token); return { priceE18: priceE18(o.token), ts: Date.now(), liquidity: p.rQuote, executableOut: od => p.quote(od.kind === 'limit_buy' ? NATIVE : od.token, od.kind === 'limit_buy' ? od.token : NATIVE, od.amount).amountOut }; });
  for (const id of fired) { const o = orders.orders.get(id)!; note('info', 'Order triggered', `${orderLabel(o)} met its condition at ${priceOf(o.token).toFixed(4)} SIM and a trade was sent. Watch Activity for the result.`); }
  for (const [id, t] of twaps) {
    try { await t.tick(); } catch (e) { note('error', 'TWAP order problem', `Order ${id}: ${(e as Error).message}`); }
    const sm = t.summary(), sig = `${sm.filled}/${sm.failed}/${sm.skipped}/${sm.done}`;
    if (twapSeen.get(id) !== sig) { twapSeen.set(id, sig); if (sm.done) note(sm.refused || sm.filled === 0 ? 'warn' : 'success', 'TWAP order finished', sm.refused ? `Nothing was traded: ${sm.refused}.` : `${sm.filled} of ${sm.slices.length} slices traded${sm.skipped ? `, ${sm.skipped} skipped` : ''}${sm.failed ? `, ${sm.failed} failed` : ''}. Open the order to see each slice.`); }
  }
  for (const [id, b] of bulks) {
    try { await b.tick(); } catch (e) { note('error', 'Multi-wallet order problem', `Order ${id}: ${(e as Error).message}`); }
    const sm = b.summary(), sig = `${sm.filled}/${sm.failed}/${sm.skipped}/${sm.done}`;
    if (bulkSeen.get(id) !== sig) { bulkSeen.set(id, sig); if (sm.done) note(sm.refused || sm.filled === 0 ? 'warn' : 'success', 'Multi-wallet order finished', sm.refused ? `Nothing was traded: ${sm.refused}.` : `${sm.filled} of ${sm.legs.length} wallets traded${sm.skipped ? `, ${sm.skipped} skipped` : ''}${sm.failed ? `, ${sm.failed} failed` : ''}. Open the order to see each wallet.`); }
  }
  for (const a of alertList) {
    const hit = alerts.evaluate(a.token, priceOf(a.token), `b${chain.block}-${a.id}`).filter(f => f.alertId === a.id);
    for (const f of hit) { a.fired = f.price; note('info', `${TOKENS[a.token].sym} price alert`, `${TOKENS[a.token].sym} is ${f.direction} ${f.threshold} SIM (now ${f.price.toFixed(4)}).`); }
  }
}
const orderLabel = (o: Order) => ({ limit_buy: 'Buy when price falls to', limit_sell: 'Sell when price rises to', take_profit: 'Take profit at', stop_loss: 'Stop loss at', trailing_stop: 'Trailing stop' }[o.kind]) + (o.trailBps ? ` ${o.trailBps / 100}% below peak` : ` ${(Number(o.triggerPriceE18 ?? 0n) / 1e18).toFixed(4)}`);
const orderStatus = (o: Order) => {
  const t: Record<string, string> = { active: 'Watching the price', fired: 'Triggered, trade sent', cancelled: 'Cancelled', expired: 'Expired', failed: 'Stopped after repeated failures', disabled: o.reason ?? 'Disabled' };
  let s = t[o.status]; if (o.status === 'active' && o.reason && o.reason !== 'trigger not met' && o.reason !== 'trigger met and executable') s = o.reason.includes('stale') ? 'Waiting for a fresh price' : o.reason.includes('liquidity') ? 'Paused: pool is too small' : o.reason.includes('executable') ? 'Condition met, but the pool cannot fill it at an acceptable price' : s;
  return s;
};

function intentFrom(b: any, key?: string): Intent {
  const token = b.token, sell = b.side === 'sell';
  return w.intent({ idempotencyKey: key ?? 'q-' + Math.random(), walletId: b.walletId || 'w1', tokenIn: sell ? token : NATIVE, tokenOut: sell ? NATIVE : token, amountIn: BigInt(b.amount || 0), slippageBps: Number(b.slippageBps ?? 300), origin: 'manual' });
}
const walletsView = () => Object.entries(WALLETS).map(([id, name]) => ({ id, name, native: chain.balance(id, NATIVE), tokens: Object.keys(TOKENS).map(t => ({ token: t, sym: TOKENS[t].sym, bal: chain.balance(id, t) })).filter(t => t.bal > 0n),
  policy: { maxPerTx: policies.get(id)!.maxPerTx[NATIVE], daily: policies.get(id)!.dailyLimit[NATIVE], automationPaused: !!policies.get(id)!.automationRevoked }, spentToday: signer.spentFor?.(id, NATIVE, Math.floor(chain.time / 86400)) ?? 0n }));

// Real read-only market data (REAL_MARKETS=1 + ALCHEMY_API_KEY): Ethereum, BNB Smart Chain and Solana coins shown on Discover. Display only: the engine never trades them.
const geckoMemo = new Map<string, { at: number; addrs: string[] }>(); let realDeps: { rpc: any } | undefined; let realCache: { at: number; data: any } | undefined; let realBusy: Promise<any> | undefined;
async function realMarkets() {
  if (process.env.REAL_MARKETS !== '1') return { enabled: false, tokens: [] };
  const key = process.env.ALCHEMY_API_KEY; if (!key) return { enabled: false, tokens: [], error: 'REAL_MARKETS=1 needs ALCHEMY_API_KEY in .env.' };
  if (realCache && Date.now() - realCache.at < 180_000) return realCache.data;
  realBusy ??= (async () => { try { const m = await import('../../packages/live/src/realmarkets.ts'); const rpc = await m.makeRpc(key); realDeps = { rpc }; await m.checkChainIds(rpc); const r = await m.loadRealMarkets({ rpc, geckoMemo }); realCache = { at: Date.now(), data: { enabled: true, ...r } }; }
    catch (e) { const msg = String((e as Error).message).split(key).join('***'); realCache = { at: Date.now() - 150_000, data: { enabled: true, tokens: realCache?.data?.tokens ?? [], error: msg } }; } finally { realBusy = undefined; } })();
  if (realCache?.data?.tokens?.length) return realCache.data;   // stale list now, fresh list on the next request: a refresh takes about a minute, so nobody waits for it
  await realBusy; return realCache!.data;
}
// Token detail (dev, holders, authorities, trades) for a token already in the real list. Cached 60 s per token; trades come from a rate-limited third party.
const infoCache = new Map<string, { at: number; data: any }>(); const ADDR = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
async function tokenInfoRoute(body: any) {
  const c = String(body.contract ?? ''); if (!ADDR.test(c)) return { ok: false, title: 'Not a token address', why: 'The contract must be an Ethereum/BNB address or a Solana mint.', fix: 'Open a token from Discover.' };
  const m = await realMarkets(); const t = (m.tokens ?? []).find((x: any) => x.contract.toLowerCase() === c.toLowerCase());
  if (!t || !realDeps) return { ok: false, title: 'Unknown token', why: 'Only tokens in the real list can be looked up.', fix: 'Reload Discover and open the token again.' };
  const hit = infoCache.get(t.contract); if (hit && Date.now() - hit.at < 60_000) return hit.data;
  const { loadTokenInfo } = await import('../../packages/live/src/tokeninfo.ts');
  let data: any; try { data = { ok: true, ...(await loadTokenInfo({ chain: t.chain, contract: t.contract, pool: t.pool, pad: t.pad }, { rpc: realDeps.rpc })) }; } catch (e) { data = { ok: false, title: 'Could not read this token', why: String((e as Error).message).slice(0, 200), fix: 'Try again in a minute.' }; }
  if (data.ok) infoCache.set(t.contract, { at: Date.now(), data }); return data;
}
// Whale feed: recent trades across the top real tokens by liquidity. Third-party data (GeckoTerminal), filled in the background one pool at a time (calls are spaced 2.2 s), refreshed at most every 120 s.
let tradeFeed: import('../../packages/live/src/indexport.ts').TradeSource | undefined; let fillBusy: Promise<void> | undefined; const WHALE_POOLS = 10;
async function whalePools() { const m = await realMarkets(); const { PAD } = await import('../../packages/live/src/launchpads.ts'); return (m.tokens ?? []).filter((t: any) => t.pool && t.pool.toLowerCase() !== PAD.fourMeme.tokenManager2.toLowerCase()).sort((a: any, b: any) => b.liq - a.liq).slice(0, WHALE_POOLS).map((t: any) => ({ id: t.id, sym: t.sym, chain: t.chain, contract: t.contract, pool: t.pool, pad: t.pad, chg: t.chg })); }
async function whalesRoute(body: any) {
  const m = await realMarkets(); if (!m.enabled || !realDeps) return { enabled: false, items: [], loaded: 0, total: 0 };
  const toks = await whalePools(); const { makeTradeSource } = await import('../../packages/live/src/indexport.ts'); tradeFeed ??= makeTradeSource({ rpc: realDeps.rpc }, { maxPoolsPerCycle: toks.length || 1 });
  const feed = tradeFeed; if (!fillBusy && Date.now() - feed.lastFill > 120_000) { feed.lastFill = Date.now(); fillBusy = feed.pollCycle(toks).then(() => { feed.lastFill = Date.now(); }).catch(() => {}).finally(() => { fillBusy = undefined; }); }
  const min = Math.max(0, Number(body.min) || 0), chains = body.chain && body.chain !== 'all' ? [String(body.chain)] : undefined;
  return { enabled: true, loaded: feed.loaded, total: toks.length, filling: !!fillBusy, at: feed.lastFill, index: feed.status(), source: feed.status().serving.includes('indexer') ? 'Our indexer (reads the chain directly)' : 'GeckoTerminal (third party); sender addresses as reported, not re-verified on-chain', errors: [...feed.errors.values()].slice(0, 3),
    items: feed.query(min, chains, 200).map(t => ({ t: t.t, side: t.side, wallet: t.wallet, usd: t.usd, tx: t.tx, sym: t.sym, chain: t.chain, contract: t.contract })) };
}
// What the Buy Bot WOULD post for the newest trades under the given settings. Nothing is sent anywhere.
async function buybotPreview(body: any) {
  if (!tradeFeed) await whalesRoute({}); const { formatBuyMessage } = await import('../../apps/telegram/buybot.ts'); const feed = tradeFeed;
  const min = Math.max(0, Number(body.min) || 0), step = Math.max(1, Number(body.emoji) || 50), sells = body.sells === '1';
  const rows = (feed?.query(min, undefined, 300) ?? []).filter(t => sells || t.side === 'buy').slice(0, 3);
  return { ok: true, items: rows.map(t => formatBuyMessage(t as any, { emojiStepUsd: step })), note: 'Preview only: real recent trades from a third-party feed. Nothing is posted anywhere.' };
}
// Real launches (Sniper page): launchpad/new-pool tokens + Raydium pool creations read from chain, with our mint check and a dry run of example sniper rules. Read-only, cached 60 s.
let launchCache: { at: number; data: any } | undefined; let launchBusy: Promise<any> | undefined;
async function launchesRoute() {
  const m = await realMarkets(); if (!m.enabled || !realDeps) return { enabled: false, items: [], notes: [] };
  if (launchCache && Date.now() - launchCache.at < 60_000) return launchCache.data;
  launchBusy ??= (async () => { try { const { loadLaunches } = await import('../../packages/live/src/launchfeed.ts'); const r = await loadLaunches({ rpc: { sol: realDeps!.rpc.sol } }, m.tokens ?? []); launchCache = { at: Date.now(), data: { enabled: true, ...r } }; }
    catch (e) { launchCache = { at: Date.now() - 45_000, data: { enabled: true, items: launchCache?.data?.items ?? [], notes: [], error: (e as Error).message } }; } finally { launchBusy = undefined; } })();
  await launchBusy; return launchCache!.data;
}
// Live launch stream (Sniper page): WebSocket log subscriptions on Solana, pushed to the browser over Server-Sent Events. Started by the first viewer, stopped 30 s after the last one leaves. Read-only.
let launchStream: import('../../packages/live/src/launchstream.ts').LaunchStream | undefined;
async function getLaunchStream() {
  const m = await realMarkets(); if (!m.enabled || !realDeps || process.env.LAUNCH_STREAM === '0') return null;
  if (!launchStream) {
    const { LaunchStream, solanaFeeds, mintEnricher } = await import('../../packages/live/src/launchstream.ts'); const { RaydiumLaunchSource } = await import('../../packages/sol/src/index.ts');
    const cfg = await import('../../packages/live/src/config.ts'); const { heliusKey, heliusWs, heliusHttp } = await import('../../packages/live/src/walletpush.ts'); const { Rpc, Paced } = await import('../../packages/live/src/rpc.ts');
    // With HELIUS_API_KEY the stream uses Helius for both the WebSocket and its transaction reads (the public endpoint rate-limits the completeness poll). SOLANA_WS_URL still wins if set.
    const hk = heliusKey(process.env.HELIUS_API_KEY), sol = hk ? new Paced(new Rpc(heliusHttp(hk), hk, fetch, 0), 150) as any : realDeps.rpc.sol, url = process.env.SOLANA_WS_URL || (hk ? heliusWs(hk) : cfg.SOLANA_PUBLIC_WS), key = hk ?? process.env.ALCHEMY_API_KEY ?? '';
    const raydium = new RaydiumLaunchSource({ chain: 'solana', program: cfg.SOL.programs[0].address, wsol: 'So11111111111111111111111111111111111111112', quoteMints: ['So11111111111111111111111111111111111111112'] }, sol);
    launchStream = new LaunchStream({ url, redact: s => { let r = s.split(url).join('<ws url>'); if (key) r = r.split(key).join('***'); return r; }, feeds: solanaFeeds({ rpc: sol, raydium, raydiumWatch: cfg.RAYDIUM_V4_POOL_CREATION_WATCH, pumpWatch: cfg.PUMP_CREATE_WATCH }), enrich: mintEnricher(sol), keep: 500 });
    // Remember what the stream saw across restarts (a file in .cache next to the project, newest 500, nothing older than 24 h). Only items the stream itself produced are loaded back.
    try { const saved = JSON.parse(readFileSync(STREAM_FILE, 'utf8')); launchStream.seed((Array.isArray(saved) ? saved : []).filter((i: any) => i?.seenAt && Date.now() - i.seenAt < 86_400_000)); } catch { /* no file yet */ }
    let t: ReturnType<typeof setTimeout> | undefined; const ls = launchStream;
    ls.on(() => { if (t) return; t = setTimeout(() => { t = undefined; try { mkdirSync(new URL('../../.cache/', import.meta.url), { recursive: true }); writeFileSync(STREAM_FILE, ser(ls.recent(500))); } catch { /* disk not writable: the board still works */ } }, 10_000); });
  }
  return launchStream;
}
const STREAM_FILE = new URL('../../.cache/launch-stream.json', import.meta.url);
async function launchStreamRoute(req: http.IncomingMessage, res: http.ServerResponse) {
  const s = await getLaunchStream();
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const write = (ev: string, data: unknown) => { res.write(`event: ${ev}\ndata: ${ser(data)}\n\n`); };
  if (!s) { write('hello', { status: { state: 'stopped', lastError: 'The live stream needs real data (npm run web:markets) and is off when LAUNCH_STREAM=0.', feeds: [] }, items: [] }); return res.end(); }
  s.start();   // keeps running after the last viewer leaves, so the "New on Solana" board has what happened while the page was closed
  write('hello', { status: s.status(), items: s.recent(300) });
  const off = s.on(i => write('launch', i)), tm = setInterval(() => write('status', s.status()), 5000);
  req.on('close', () => { off(); clearInterval(tm); });
}
// Real wallet view (Wallets and Portfolio pages): balances of ANY public address, read-only. Cached 30 s per chain+address; the cache is bounded.
const walletCache = new Map<string, { at: number; data: any }>();
async function watchWalletRoute(body: any) {
  const m = await realMarkets(); if (!m.enabled || !realDeps) return { ok: false, title: 'Real data is off', why: 'Watching a real address needs the real-markets server.', fix: 'Start it with npm run web:markets.' };
  const chain = String(body.chain ?? ''), address = String(body.address ?? '').trim();
  if (!['ethereum', 'bnb', 'solana'].includes(chain)) return { ok: false, title: 'Unknown chain', why: 'Pick Ethereum, BNB or Solana.', fix: 'Choose one of the three chains.' };
  const k = `${chain}:${address.toLowerCase()}`, hit = walletCache.get(k); if (hit && Date.now() - hit.at < 30_000) return hit.data;
  const { loadWalletView } = await import('../../packages/live/src/walletview.ts'); const rpc = realDeps.rpc;
  let data: any; try { data = { ok: true, ...(await loadWalletView({ rpcFor: (c: string) => (c === 'ethereum' ? rpc.ethereum : c === 'bnb' ? rpc.bsc : rpc.sol) }, { chain: chain as any, address })) }; }
  catch (e) { return { ok: false, title: 'Could not read this address', why: (e as Error).message, fix: 'Check the address and the chain, then try again.' }; }
  walletCache.set(k, { at: Date.now(), data }); if (walletCache.size > 200) walletCache.delete(walletCache.keys().next().value as string); return data;
}
// Real recent trades of ANY public wallet (Copy trade page, track-only). The copy rules run in track-only mode on each BUY: they say what a follower with a fixed 0.1-native-coin copy size would do. Nothing is sent.
const tradesCache = new Map<string, { at: number; data: any }>();
// Push for tracked Solana wallets (Helius WebSocket, read-only). A notification drops the wallet's cached history so the next read is fresh and bumps `activityAt`, which the page polls cheaply.
// Off when HELIUS_API_KEY is not set: the tracker then works exactly as before (60 s cache). At most 5 wallets are watched, like the page's limit; the oldest is dropped first.
const pushReg = new Map<string, { push: any; activityAt: number; count: number }>();
async function ensurePush(chain: string, address: string) {
  if (chain !== 'solana') return false;
  const { WalletPush, heliusKey, heliusWs } = await import('../../packages/live/src/walletpush.ts'); const key = heliusKey(process.env.HELIUS_API_KEY); if (!key) return false;
  const k = `${chain}:${address.toLowerCase()}`; if (pushReg.has(k)) return true;
  if (pushReg.size >= 5) { const old = pushReg.keys().next().value as string; pushReg.get(old)?.push.stop(); pushReg.delete(old); }
  const ent = { push: null as any, activityAt: 0, count: 0 };
  try { ent.push = new WalletPush({ url: heliusWs(key), wallets: [address], onActivity: () => { ent.activityAt = Date.now(); ent.count++; tradesCache.delete(k); } }); } catch { return false; }
  pushReg.set(k, ent); ent.push.start(); return true;
}
async function pulseRoute(body: any) {
  const items = Array.isArray(body?.items) ? body.items.slice(0, 5) : [];
  return { ok: true, items: items.map((w: any) => { const e = pushReg.get(`${String(w.chain)}:${String(w.address ?? '').toLowerCase()}`); return { chain: w.chain, address: w.address, live: !!e && e.push.status().state === 'live', activityAt: e?.activityAt ?? 0, count: e?.count ?? 0 }; }) };
}
async function watchTradesRoute(body: any) {
  const m = await realMarkets(); if (!m.enabled || !realDeps) return { ok: false, title: 'Real data is off', why: 'Tracking a real wallet needs the real-markets server.', fix: 'Start it with npm run web:markets.' };
  const chain = String(body.chain ?? ''), address = String(body.address ?? '').trim();
  if (!['ethereum', 'bnb', 'solana'].includes(chain)) return { ok: false, title: 'Unknown chain', why: 'Pick Ethereum, BNB or Solana.', fix: 'Choose one of the three chains.' };
  const pushing = await ensurePush(chain, address).catch(() => false), k = `${chain}:${address.toLowerCase()}`, hit = tradesCache.get(k); if (hit && Date.now() - hit.at < 60_000) return hit.data;
  const startedAt = Date.now(); const { loadWalletTrades } = await import('../../packages/live/src/wallettrades.ts'); const { CopyEngine, NATIVE } = await import('../../packages/core/src/index.ts'); const rpc = realDeps.rpc;
  let data: any; try {
    const r = await loadWalletTrades({ rpcFor: (c: string) => (c === 'ethereum' ? rpc.ethereum : c === 'bnb' ? rpc.bsc : rpc.sol) }, { chain: chain as any, address, limit: Number(body.limit) || 20 });
    const fixed = chain === 'solana' ? 10n ** 8n : 10n ** 17n, big = 10n ** 30n;
    const cfg: any = { follower: 'you', walletId: 'you', userId: 'you', leader: r.address, chain, quoteToken: NATIVE, mode: 'fixed', fixed, ratioBps: 0, sides: 'both', maxPerLeader: big, maxPerToken: big, dailyLimit: big, maxPositions: 99, cooldownS: 0, minLiquidity: 0n, maxDeviationBps: 10_000, minConfirmations: 0, followLeaderExit: true, slippageBps: 300, venues: [], trackOnly: true };
    const items = [...r.events].reverse().map(ev => {   // oldest first so the engine sees them in order; shown newest first below
      const eng = new CopyEngine([cfg], () => ({ priceE18: ev.leaderPriceE18 || 1n, liquidity: big }), () => {}, () => Math.floor(Date.now() / 1000)); eng.onEvent({ ...ev, confirmations: 99 });
      const ex = r.extras[ev.txHash] ?? { quoteSym: '', quoteToken: '' }, meta = r.tokens[ev.token] ?? {}, qd = ex.quoteSym === 'SOL' ? 9 : /^USD/.test(ex.quoteSym) ? 6 : 18;
      const raw = eng.log.at(-1)?.decision ?? '', decision = ev.kind !== 'swap' ? 'Not a swap, so nothing would be copied.' : ev.side === 'sell' ? 'A sell is mirrored only for tokens you bought through this wallet.' : /^track-only: would buy/.test(raw) ? 'Would copy this buy with your fixed size (0.1 of the chain coin).' : raw ? `Would skip: ${raw.replace(/^skip: /, '')}` : 'No decision recorded.';
      return { tx: ev.txHash, ts: ex.ts ?? null, kind: ev.kind, side: ev.side, token: ev.token, sym: meta.sym ?? null, name: meta.name ?? null, tokenDecimals: meta.decimals ?? null, tokenAmount: String(ev.tokenAmount), quoteAmount: String(ev.quoteAmount), quoteSym: ex.quoteSym, quoteDecimals: qd, decision };
    }).reverse();
    data = { ok: true, chain, address: r.address, items, notes: r.notes, at: r.at, push: pushing };
  } catch (e) { return { ok: false, title: 'Could not read this wallet', why: (e as Error).message, fix: 'Check the address and the chain, then try again.' }; }
  if ((pushReg.get(k)?.activityAt ?? 0) >= startedAt) return data;   // the wallet did something while we were reading: this result may predate it, so do not cache it
  tradesCache.set(k, { at: Date.now(), data }); if (tradesCache.size > 100) tradesCache.delete(tradesCache.keys().next().value as string); return data;
}
// Routes that only read real public data. One table so the practice and real-node servers share them.
let solMainInst: import('./solmainnet.ts').SolMainnet | undefined; const solMain = async () => solMainInst ??= new (await import('./solmainnet.ts')).SolMainnet();
const REAL_ROUTES: Record<string, (body: any) => Promise<any>> = { '/api/markets': () => realMarkets(), '/api/whales': b => whalesRoute(b), '/api/buybot/preview': b => buybotPreview(b), '/api/tokeninfo': b => tokenInfoRoute(b), '/api/launches': () => launchesRoute(), '/api/sol/search': async b => (await import('./solroutes.ts')).solSearch(b), '/api/sol/token': async b => (await import('./solroutes.ts')).solToken(b), '/api/sol/wallet/status': async () => (await solMain()).status(), '/api/sol/wallet/connect': async b => (await solMain()).connect(b), '/api/sol/wallet/disconnect': async () => (await solMain()).disconnect(), '/api/sol/settings': async b => { const m = await solMain(); return b && b.maxTradeSol !== undefined ? m.setLimits(b) : m.status(); }, '/api/sol/kill': async b => (await solMain()).killSwitch(b?.on !== false), '/api/sol/trade/prepare': async b => (await solMain()).prepare(b), '/api/sol/trade/confirm': async b => (await solMain()).confirm(b), '/api/sol/simulate': async b => (await import('./solroutes.ts')).solSimulate(b), '/api/watch/wallet': b => watchWalletRoute(b), '/api/watch/pulse': b => pulseRoute(b), '/api/watch/trades': b => watchTradesRoute(b) };
async function api(path: string, body: any, method: string) {
  if (REAL_ROUTES[path]) return REAL_ROUTES[path](body);
  switch (path) {
    case '/api/overview': return { simulated: true, block: chain.block, wallets: walletsView(), tokens: Object.entries(TOKENS).map(([a, t]) => ({ address: a, contract: CONTRACT[a], ...t, price: priceOf(a), liquidity: poolOf(a).rQuote, opensAtBlock: chain.tokens.get(a)?.tradingOpenBlock, open: !(chain.tokens.get(a)?.tradingOpenBlock && chain.block + 1 < chain.tokens.get(a)!.tradingOpenBlock!) })), notes: notes.length };
    case '/api/notes': return notes.filter(n => n.id > Number(body?.after ?? 0));
    case '/api/risk': { const t = body.token; const r = analyze(chain, { address: t, lpLockedPct: null }, { wallet: 'w1', quoteToken: NATIVE, venue: TOKENS[t].venue, amount: 10_000n }); return r; }
    case '/api/quote': {
      const i = intentFrom(body); const bal = chain.balance(i.walletId, i.tokenIn); const warnings: { level: Level; text: string }[] = [];
      let q; try { q = engine.d.router.route(i, 100).best; } catch (e) { return { ok: false, ...explain((e as Error).message) }; }
      const minOut = q.amountOut * BigInt(10_000 - i.slippageBps) / 10_000n; const fee = i.amountIn * 100n / 10_000n;
      if (i.amountIn <= 0n) warnings.push({ level: 'info', text: 'Enter an amount to see a preview.' });
      if (bal < i.amountIn) warnings.push({ level: 'error', text: `This wallet holds ${bal} but you entered ${i.amountIn}.` });
      if (q.priceImpactBps > 300) warnings.push({ level: 'warn', text: `Large price impact (${(q.priceImpactBps / 100).toFixed(2)}%). Your trade moves the price noticeably; consider a smaller amount.` });
      if (body.side === 'buy' && i.amountIn > 0n) { const rk = analyze(chain, { address: body.token, lpLockedPct: null }, { wallet: 'w1', quoteToken: NATIVE, venue: TOKENS[body.token].venue, amount: 10_000n }); const tax = rk.buyTaxBps ?? 0; if (tax > i.slippageBps) warnings.push({ level: 'warn', text: `This token takes about ${(tax / 100).toFixed(0)}% when you buy, which is more than your ${(i.slippageBps / 100).toFixed(0)}% slippage. The trade would be stopped. Raise slippage above the tax only if you accept paying it.` }); if (rk.verdict === 'blocked') warnings.push({ level: 'error', text: 'The safety check found a serious problem with this token. Open the safety report on the right.' }); }
      const ob = chain.tokens.get(body.token)?.tradingOpenBlock; if (ob && chain.block + 1 < ob) warnings.push({ level: 'error', text: `Trading opens at block ${ob}; the chain is at ${chain.block}.` });
      return { ok: true, venue: q.venue, block: q.block, expectedOut: q.amountOut, minOut, impactBps: q.priceImpactBps, fees: { platform: fee, pool: q.venueFee, network: chain.gasFee }, warnings };
    }
    case '/api/trade': {
      const i = intentFrom(body, 'ui-' + (body.clientId ?? Math.random())); const existing = store.records.has(i.idempotencyKey);
      const rec = await engine.submit(i); if (!existing) note('info', `${body.side === 'buy' ? 'Buy' : 'Sell'} sent`, 'Your trade was submitted. A submission is not a fill: you will get a message when it is confirmed.');
      if (rec.state === 'failed') { const e = explain(rec.failure); note('error', e.title, `${e.why} ${e.fix}`); }
      await settle(); return txView(rec);
    }
    case '/api/bulk': {
      const view = (id: string, b: BulkRunner) => bulkView(id, b, { token: TOKENS[(b as any).d.spec.token]?.sym ?? '?', walletName: w => WALLETS[w] ?? w });
      if (method === 'GET') return [...bulks].map(([id, b]) => view(id, b)).reverse();
      const side = body.side === 'sell' ? 'sell' : 'buy', token = body.token; if (!TOKENS[token]) return { ok: false, title: 'Unknown token', why: 'That token is not on the practice network.', fix: 'Pick a token from the list.' };
      const ws: string[] = Array.isArray(body.walletIds) ? body.walletIds.filter((w: string) => WALLETS[w]) : []; if (!ws.length) return { ok: false, title: 'Pick at least one wallet', why: 'A multi-wallet order needs wallets to trade from.', fix: 'Tick one or more wallets.' };
      let total: bigint; try { total = BigInt(body.total); if (total <= 0n) throw 0; } catch { return { ok: false, title: 'Check the amount', why: 'Enter a whole number greater than zero.', fix: 'Try again with a number such as 40000.' }; }
      const id = 'bk' + (bulks.size + 1);
      try {
        const legs = body.amounts ? ws.map(w => ({ walletId: w, amount: BigInt(body.amounts[w] ?? 0) })) : splitEqual(ws, total);
        bulks.set(id, new BulkRunner({ engine, chain: chain as any, spec: { id, userId: USER, chain: 'sim-evm', token, quoteToken: NATIVE, venues: ['uniswap-v2'], side, legs, slippageBps: Number(body.slippageBps ?? 500), maxImpactBps: pctToBps(body.maxImpactPct, 'Maximum price impact'), mode: body.mode === 'parallel' ? 'parallel' : 'sequential', onFailure: body.onFailure === 'stop' ? 'stop' : 'continue' } }));
      } catch (e) { return { ok: false, title: 'Check the multi-wallet settings', why: (e as Error).message + '.', fix: 'Adjust the setting and try again.' }; }
      note('success', 'Multi-wallet order started', 'Each wallet trades on its own. This is not all-or-nothing: if one wallet fails, the others can still trade.'); await settle(); return { ok: true, id };
    }
    case '/api/twap': {
      const view = (id: string, t: TwapRunner) => { const sm = t.summary(), sp = (t as any).d.spec; const st = sm.cancelled ? 'Cancelled' : sm.refused ? 'Refused' : sm.done ? 'Finished' : sm.slices.some(x => x.status === 'inflight') ? 'Sending a slice' : (sm.slices.find(x => x.status === 'pending')?.waiting ? 'Waiting: ' + sm.slices.find(x => x.status === 'pending')!.waiting : 'Waiting for the next slice');
        return { id, side: sp.side, tokenAddr: sp.token, token: TOKENS[sp.token]?.sym ?? sp.token, walletId: sp.walletId, total: sp.total, slicesTotal: sm.slices.length, intervalS: sp.intervalS, filled: sm.filled, failed: sm.failed, skipped: sm.skipped, open: sm.open, spent: sm.spent, received: sm.received, avgPrice: sm.avgPriceE18 ? Number(sm.avgPriceE18) / 1e18 : null, limitPrice: sp.limitPriceE18 ? Number(sp.limitPriceE18) / 1e18 : null, nextInS: sm.nextDueAt === undefined ? null : Math.max(0, sm.nextDueAt - chain.time), done: sm.done, cancelled: sm.cancelled, refused: sm.refused ?? null, statusText: st,
          slices: sm.slices.map(x => ({ n: x.n + 1, amount: x.amount, status: x.status, reason: x.reason ?? null, waiting: x.waiting ?? null, spent: x.spent ?? null, received: x.received ?? null, dueInS: x.dueAt - chain.time })) }; };
      if (method === 'GET') return [...twaps].map(([id, t]) => view(id, t)).reverse();
      const active = [...orders.orders.values()].filter(o => o.status === 'active').length + [...twaps.values()].filter(t => !t.summary().done).length;
      const lim = enforce(cfgTier, tier, 'limitOrders', active);
      if (!lim.allow) return { ok: false, title: 'Order limit reached', why: `Your ${tier} plan allows ${cfgTier.tiers[tier].limits.limitOrders} active orders.`, fix: 'Cancel an order or switch plan in Plan & fees.' };
      const side = body.side === 'sell' ? 'sell' : 'buy', token = body.token, wallet = body.walletId || 'w1'; if (!TOKENS[token]) return { ok: false, title: 'Unknown token', why: 'That token is not on the practice network.', fix: 'Pick a token from the list.' };
      let total: bigint; try { total = BigInt(body.total); } catch { return { ok: false, title: 'Check the amount', why: 'Enter a whole number greater than zero.', fix: 'Try again with a number such as 40000.' }; }
      const have = chain.balance(wallet, side === 'buy' ? NATIVE : token);
      if (have < total) return { ok: false, title: 'Not enough balance', why: `This wallet holds ${have} and the order needs ${total}. A TWAP order needs the whole amount up front.`, fix: 'Lower the amount or fund the wallet.' };
      const id = 'tw' + (twaps.size + 1);
      try {
        const t = new TwapRunner({ engine, chain: chain as any, spec: { id, userId: USER, walletId: wallet, chain: 'sim-evm', token, quoteToken: NATIVE, venues: ['uniswap-v2'], side, total, slices: Number(body.slices), intervalS: Number(body.intervalS), slippageBps: Number(body.slippageBps ?? 500),
          limitPriceE18: body.limitPrice ? toE18(Number(body.limitPrice)) : undefined, maxSliceImpactBps: body.maxImpactPct ? Math.round(Number(body.maxImpactPct) * 100) : undefined, jitterPct: body.jitterPct ? Number(body.jitterPct) : undefined, onFailure: body.onFailure === 'stop' ? 'stop' : 'continue' } });
        twaps.set(id, t);
      } catch (e) { return { ok: false, title: 'Check the TWAP settings', why: (e as Error).message + '.', fix: 'Adjust the highlighted setting and try again.' }; }
      note('success', 'TWAP order started', 'The first slice goes now, the rest follow on schedule. A slice that cannot go within its window is skipped and reported, never made up later.'); await settle(); return { ok: true, id };
    }
    case '/api/twap/cancel': { const t = twaps.get(body.id); if (!t) return { ok: false, title: 'No such order', why: 'That TWAP order does not exist.', fix: 'Refresh the page.' }; t.cancel(); note('info', 'TWAP order cancelled', 'Slices not yet sent were skipped. A slice already sent will still finish.'); await settle(); return { ok: true }; }
    case '/api/twap/forward': { const sec = Math.max(1, Math.min(86_400, Math.round(Number(body?.seconds ?? 300)))); chain.mine(4); await settle();   // let the slice already sent confirm first: jumping the clock past a waiting trade's deadline would (correctly) make it expire
      chain.time += sec; await settle(); return { ok: true, time: chain.time }; }
    case '/api/mine': chain.mine(Number(body?.n ?? 1)); await settle(); return { block: chain.block };
    case '/api/txs': return [...store.records.values()].map(txView).reverse();
    case '/api/market-move': {
      const up = body.direction === 'up'; chain.credit('w2', '0xMEME', 600_000n);
      const chunks = up ? [90_000n, 90_000n, 90_000n, 90_000n, 90_000n] : [380_000n];
      for (const c of chunks) await engine.submit(w.intent({ idempotencyKey: 'mm-' + Math.random(), walletId: 'w2', tokenIn: up ? NATIVE : '0xMEME', tokenOut: up ? '0xMEME' : NATIVE, amountIn: c, slippageBps: 5000, origin: 'manual' }));
      chain.mine(); await settle(); note('info', 'Simulated market move', `MEME price is now ${priceOf('0xMEME').toFixed(4)} SIM. (Demo control: a second wallet traded to move the price.)`); return { price: priceOf('0xMEME') };
    }
    case '/api/orders': {
      if (method === 'GET') return [...orders.orders.values()].map(o => ({ walletId: o.walletId, tokenAddr: o.token, attempts: o.attempts, id: o.id, label: orderLabel(o), kind: o.kind, token: TOKENS[o.token].sym, amount: o.amount, status: o.status, statusText: orderStatus(o), oco: o.ocoGroup, expiresIn: o.expiresAt - chain.time }));
      const active = [...orders.orders.values()].filter(o => o.status === 'active').length; const need = body.kind === 'bracket' ? 2 : 1;
      const lim = enforce(cfgTier, tier, 'limitOrders', active + need - 1);
      if (!lim.allow) return { ok: false, title: 'Order limit reached', why: `Your ${tier} plan allows ${cfgTier.tiers[tier].limits.limitOrders} active orders.`, fix: 'Cancel an order or switch plan in Plan & fees.' };
      const token = body.token; const amount = BigInt(body.amount); const mk = (id: string, kind: Order['kind'], price?: number, extra: Partial<Order> = {}): Order => ({ id, userId: USER, walletId: body.walletId || 'w1', chain: 'sim-evm', token, quoteToken: NATIVE, kind, amount,
        triggerPriceE18: price ? toE18(price) : undefined, expiresAt: chain.time + 7 * 86400, maxQuoteAgeMs: 60_000, minLiquidity: 10_000n, maxDeviationBps: 500, maxAttempts: 2, slippageBps: Number(body.slippageBps ?? 500), venues: ['uniswap-v2'], status: 'active', attempts: 0, ...extra });
      const id = 'o' + (orders.orders.size + 1);
      try {
        if (body.kind === 'bracket') { orders.place(mk(id + 'a', 'take_profit', Number(body.tp), { ocoGroup: id })); orders.place(mk(id + 'b', 'stop_loss', Number(body.sl), { ocoGroup: id })); }
        else if (body.kind === 'trailing_stop') orders.place(mk(id, 'trailing_stop', undefined, { trailBps: Math.round(Number(body.trailPct) * 100) }));
        else orders.place(mk(id, body.kind, Number(body.price)));
      } catch (e) { return { ok: false, title: 'Not enough free balance', why: 'The tokens or funds needed for this order are already reserved by another order, or you do not hold enough.', fix: 'Cancel an order or lower the amount. One balance can never back two orders at once.' }; }
      note('success', 'Order placed', 'It will only trigger when the price condition is met and the pool can actually fill it.'); await settle(); return { ok: true };
    }
    case '/api/orders/cancel': { orders.cancel(body.id); const o = orders.orders.get(body.id); if (o?.ocoGroup) for (const s of orders.orders.values()) if (s.ocoGroup === o.ocoGroup) orders.cancel(s.id); note('info', 'Order cancelled', 'The reserved balance is free again.'); return { ok: true }; }
    case '/api/copy': {
      if (method === 'POST') { if (body.enabled !== undefined) copyOn = !!body.enabled; for (const k of ['mode', 'sides'] as const) if (body[k]) (copyCfg as any)[k] = body[k]; if (body.fixed) copyCfg.fixed = BigInt(body.fixed); if (body.ratioPct) copyCfg.ratioBps = Math.round(Number(body.ratioPct) * 100); if (body.maxPerToken) copyCfg.maxPerToken = BigInt(body.maxPerToken); if (body.dailyLimit) copyCfg.dailyLimit = BigInt(body.dailyLimit); if (body.maxDeviationPct) copyCfg.maxDeviationBps = Math.round(Number(body.maxDeviationPct) * 100); if (body.followLeaderExit !== undefined) copyCfg.followLeaderExit = !!body.followLeaderExit; if (body.walletId && WALLETS[body.walletId]) copyCfg.walletId = body.walletId; note('success', 'Copy settings saved', copyOn ? 'Copy trading is on.' : 'Copy trading is paused.'); }
      return { enabled: copyOn, cfg: { walletId: copyCfg.walletId, maxDeviationPct: copyCfg.maxDeviationBps / 100, followLeaderExit: copyCfg.followLeaderExit, mode: copyCfg.mode, sides: copyCfg.sides, fixed: copyCfg.fixed, ratioPct: copyCfg.ratioBps / 100, maxPerToken: copyCfg.maxPerToken, maxPerLeader: copyCfg.maxPerLeader, dailyLimit: copyCfg.dailyLimit }, leader: 'whale.sim', leaderHolds: leaderBal, ...copyStats(),
        inventory: Object.keys(TOKENS).map(t => ({ sym: TOKENS[t].sym, qty: copy.attributed('me', 'whale.sim', t) })).filter(x => x.qty > 0n), log: copy.log.slice(-8).reverse().map(l => ({ ...l, text: l.decision === 'emit' ? 'Copied: a trade was sent.' : friendlySkip(l.decision) })) };
    }
    case '/api/copy/leader': {
      if (!copyOn) return { ok: false, title: 'Copy trading is paused', why: 'Turn it on first, otherwise leader trades are ignored.', fix: 'Use the switch at the top of this page.' };
      const buy = body.side === 'buy'; const amt = BigInt(body.amount); const tok = body.token || '0xMEME'; const n = ++evN; const tokens = amt * 1_000_000n / (poolOf(tok).rQuote || 1n);
      const before = leaderBal; leaderBal = buy ? leaderBal + tokens : (leaderBal > tokens ? leaderBal - tokens : 0n);
      copy.onEvent({ provider: 'demo', chain: 'sim-evm', txHash: '0xleader' + n, logIndex: 0, leader: 'whale.sim', kind: body.kind === 'transfer' ? 'transfer' : 'swap', side: buy ? 'buy' : 'sell', token: tok, quoteAmount: amt, tokenAmount: tokens, leaderBalanceBefore: before, leaderBalanceAfter: leaderBal, leaderPriceE18: priceE18(tok), confirmations: 2 });
      await settle(); return { ok: true };
    }
    case '/api/portfolio': {
      const prices = new Map<string, { num: bigint; den: bigint }>(); for (const t of Object.keys(TOKENS)) { const p = poolOf(t); prices.set(`sim-evm|${t}`, { num: p.rQuote, den: p.rToken }); }
      return { positions: portfolio.positions(USER, prices).map(p => ({ ...p, sym: TOKENS[p.token]?.sym ?? p.token, price: priceOf(p.token) })), history: portfolio.history(USER).slice(-10).reverse().map(h => ({ ...h, sym: TOKENS[h.token]?.sym })), wallets: walletsView() };
    }
    case '/api/alerts': {
      if (method === 'POST') { const id = 'a' + (alertList.length + 1); if (!alerts.add({ id, userId: USER, token: body.token, direction: body.direction, threshold: Number(body.threshold) })) return { ok: false, title: 'Invalid alert', why: 'The price must be greater than zero.', fix: 'Enter a price such as 1.25.' }; alertList.push({ id, token: body.token, direction: body.direction, threshold: Number(body.threshold) }); note('success', 'Alert created', `You will be told once when ${TOKENS[body.token].sym} goes ${body.direction} ${body.threshold} SIM.`); }
      return alertList.map(a => ({ ...a, sym: TOKENS[a.token].sym, now: priceOf(a.token) }));
    }
    case '/api/signals': {
      const out = []; for (const c of extract(String(body.text || ''))) {
        const key = BY_CONTRACT[c.address.toLowerCase()]; const known = key ? TOKENS[key] : undefined; const dup = seenSignals.has(c.address.toLowerCase());
        if (!known) { out.push({ address: c.address, family: c.family, status: 'unknown', message: 'This address was not found on any connected network, so it cannot be traded.' }); continue; }
        seenSignals.add(c.address.toLowerCase()); const risk = analyze(chain, { address: key!, lpLockedPct: null }, { wallet: 'w1', quoteToken: NATIVE, venue: known.venue, amount: 10_000n });
        out.push({ address: c.address, token: key, family: c.family, sym: known.sym, status: dup ? 'duplicate' : 'new', verdict: risk.verdict, flags: risk.flags, message: dup ? 'You already saw this contract in an earlier message.' : 'Preview only. Nothing is bought automatically.' });
      } return out;
    }
    case '/api/launch-check': {
      const t = body.token; const s = simulateLaunch(chain, { token: t, venue: TOKENS[t].venue, amount: BigInt(body.amount || 10_000) }); return { sim: s, sym: TOKENS[t].sym };
    }
    case '/api/wallets/automation': { const p = policies.get(body.id)!; p.automationRevoked = !!body.paused; note(body.paused ? 'warn' : 'success', body.paused ? 'Automation paused' : 'Automation resumed', body.paused ? `Orders, copy trading and sniping cannot sign for ${WALLETS[body.id]}. Manual trades still work.` : `Automatic strategies can trade with ${WALLETS[body.id]} again, within its limits.`); return { ok: true }; }
    case '/api/plan': {
      if (method === 'POST') { tier = body.tier; note('info', 'Plan changed (demo)', `You are now on ${tier}. No payment is taken in this simulation.`); }
      const active = [...orders.orders.values()].filter(o => o.status === 'active').length;
      return { tier, tiers: Object.values(cfgTier.tiers).map(t => ({ id: t.id, limits: t.limits })), usage: { limitOrders: active }, platformFeeBps: 100, volume: portfolio.platformVolume(USER) };
    }
    case '/api/pause-entries': { if (method === 'POST') { entriesPaused = !!body.paused; note(entriesPaused ? 'warn' : 'success', entriesPaused ? 'New automated entries paused' : 'Automated entries resumed', entriesPaused ? 'Automated buys are blocked. Exits, stop losses, manual trades and your wallets are unchanged.' : 'Automated strategies can open new positions again, within their limits.'); } return { paused: entriesPaused }; }
    case '/api/audit': return signer.audit.slice(-15).reverse().map(a => ({ ...a, text: a.decision === 'allow' ? 'Signing approved by wallet policy.' : explain(a.reason).title + ': ' + explain(a.reason).why }));
  }
  return undefined;
}

// ---------- Telegram: link a private chat to this practice account, then trade from it ----------
// The bot runs inside this server (one poller per token) when TELEGRAM_BOT_TOKEN is set. /buy and /sell from a linked chat go through the SAME engine and wallet limits as the web.
// Practice only: this is the simulated chain with fake funds. The real-node terminal does not offer Telegram trading.
mkdirSync(new URL('../../.cache/', import.meta.url), { recursive: true });
const linker = new LinkStore({ file: process.env.TELEGRAM_LINKS_FILE !== undefined ? process.env.TELEGRAM_LINKS_FILE || undefined : new URL('../../.cache/telegram-links.json', import.meta.url).pathname });   // TELEGRAM_LINKS_FILE='' keeps links in memory only (used by tests)
const tg: { state: 'off' | 'starting' | 'running' | 'error'; bot?: string; error?: string } = { state: 'off' };
const resolveToken = (t: string) => {
  const k = Object.keys(TOKENS).find(a => a === t) ?? BY_CONTRACT[t.toLowerCase()] ?? Object.keys(TOKENS).find(a => TOKENS[a].sym.toLowerCase() === t.toLowerCase());
  if (!k) throw new Error(`Unknown token "${t.slice(0, 20)}". Practice tokens: ${Object.values(TOKENS).map(x => x.sym).join(', ')}.`); return k;
};
const telegramCtx = (userId: string): TgCtx => ({ userId, walletId: 'w1', chain: 'sim-evm', native: NATIVE, autoTrade: false, quickBuy: 1000n, now: () => chain.time,
  async submit(i) {
    const buy = i.tokenIn === NATIVE, token = resolveToken(buy ? i.tokenOut : i.tokenIn);
    const intent = w.intent({ idempotencyKey: i.idempotencyKey, walletId: 'w1', tokenIn: buy ? NATIVE : token, tokenOut: buy ? token : NATIVE, amountIn: i.amountIn, slippageBps: i.slippageBps, origin: 'telegram' as any });
    const existing = store.records.has(intent.idempotencyKey), rec = await engine.submit(intent);
    if (!existing) note('info', `Telegram ${buy ? 'buy' : 'sell'} sent`, `A linked Telegram chat sent ${buy ? 'a buy' : 'a sell'} of ${TOKENS[token].sym}. It goes through the same wallet limits as the web.`);
    chain.mine(); await settle(); const r = store.records.get(intent.idempotencyKey) ?? rec;   // the practice chain has no clock of its own: mine one block so the chat gets a confirmation, not just a submission
    if (r.state === 'failed') { const e = explain(r.failure); return { state: `failed (${e.title}. ${e.why} ${e.fix})` }; }
    return { state: r.state };
  } });
const telegramApi = (path: string) => {
  const token = process.env.TELEGRAM_BOT_TOKEN, notOn = { ok: false, title: 'Telegram is not set up', why: 'No bot token is configured, so there is nothing to link to.', fix: 'Put TELEGRAM_BOT_TOKEN (from @BotFather) in .env and restart the terminal.' };
  if (path === '/api/telegram/status') return { configured: !!token, state: tg.state, bot: tg.bot ?? null, error: tg.error ?? null, linkedChats: linker.chatsOf(USER).length, practiceOnly: true, network: live ? 'fork' : 'practice' };
  if (!token || tg.state !== 'running') return tg.state === 'error' ? { ok: false, title: 'The Telegram bot is not running', why: tg.error ?? '', fix: 'Check the token in .env and restart the terminal.' } : notOn;
  if (path === '/api/telegram/link') { const c = linker.issue(USER); return { ok: true, code: c.code, expiresInMin: Math.round(c.expiresInS / 60), bot: tg.bot, steps: [`Open Telegram and message @${tg.bot}.`, `Send:  /link ${c.code}`, 'The code works once and expires in 10 minutes.'] }; }
  if (path === '/api/telegram/unlink') { const n = linker.unlinkAccount(USER); note('info', 'Telegram unlinked', n ? `${n} chat${n === 1 ? '' : 's'} can no longer trade.` : 'No chats were linked.'); return { ok: true, removed: n }; }
  return undefined;
};
async function startTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN; if (!token || process.env.TELEGRAM_BOT === '0') return;
  tg.state = 'starting'; const redact = (m: string) => m.split(token).join('***');
  try {
    const me: any = await fetch(`${process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org'}/bot${token}/getMe`).then(r => r.json()); if (!me.ok) throw new Error(me.description ?? 'Telegram rejected the token');
    const { startTelegram } = await import('../telegram/start.ts');
    await startTelegram({ token, key: process.env.REAL_MARKETS === '1' ? process.env.ALCHEMY_API_KEY : undefined, arbitrumUrl: process.env.ARBITRUM_RPC_URL, apiBase: process.env.TELEGRAM_API_BASE, linker, ctxFor: live ? live.telegramCtx : telegramCtx, log: m => console.log('[telegram] ' + redact(m)) });
    tg.bot = me.result.username; tg.state = 'running'; console.log(`[telegram] bot @${tg.bot} is running inside this terminal (trading on the ${live ? 'local fork' : 'practice network'}, /link enabled)`);
  } catch (e) { tg.state = 'error'; tg.error = redact((e as Error).message); console.error('[telegram] not started: ' + tg.error); }
}

// Real-node mode: TERMINAL_MODE=fork starts a LOCAL anvil fork of Ethereum mainnet (needs ALCHEMY_API_KEY, read-only, never sent to anvil's argv) and serves the
// supported endpoints from OUR engine over EvmRpcChain instead of the simulator. Everything stays on loopback with fake ETH.
let live: Awaited<ReturnType<typeof import('./livemode.ts').createLive>> | undefined; let stopFork = () => {};
if (process.env.TERMINAL_MODE === 'fork') {
  const key = process.env.ALCHEMY_API_KEY; if (!key) { console.error('TERMINAL_MODE=fork needs ALCHEMY_API_KEY (put it in .env).'); process.exit(2); }
  const { startFork } = await import('../../packages/live/src/forkenv.ts'); const { createLive } = await import('./livemode.ts');
  const fork = await startFork(key, Number(process.env.FORK_PORT ?? 8655)); stopFork = fork.stop; live = await createLive(fork.node);
  setInterval(() => { live!.settle().catch(() => {}); }, 3000).unref();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { stopFork(); process.exit(0); });
  console.log('REAL-NODE mode: trades go through the engine to a local anvil fork of Ethereum mainnet (fake ETH, nothing reaches mainnet).');
}
http.createServer(async (req, res) => {
  const u = new URL(req.url!, 'http://x');
  const send = (code: number, body: string, type = 'application/json') => { res.writeHead(code, { 'content-type': type + '; charset=utf-8' }); res.end(body); };
  const STATIC: Record<string, string> = { '/styles.css': 'text/css', '/data.js': 'text/javascript', '/app.js': 'text/javascript', '/views.js': 'text/javascript', '/views2.js': 'text/javascript', '/views3.js': 'text/javascript' };
  if (STATIC[u.pathname]) return send(200, readFileSync(new URL('.' + u.pathname, import.meta.url), 'utf8'), STATIC[u.pathname]);
  if (u.pathname === '/') return send(200, readFileSync(new URL('./index.html', import.meta.url), 'utf8'), 'text/html');
  if (u.pathname === '/api/launches/stream') return launchStreamRoute(req, res).catch(() => { try { res.end(); } catch { /* closed */ } });
  let body: any = Object.fromEntries(u.searchParams);
  if (req.method === 'POST') { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return send(400, '{}'); } }
  if (u.pathname.startsWith('/api/telegram/')) { const r = telegramApi(u.pathname); return r === undefined ? send(404, '{}') : send(200, ser(r)); }
  if (u.pathname.startsWith('/api/sol/') && req.method === 'POST') {   // the terminal has no login: refuse cross-site and non-JSON posts so a web page you visit cannot drive a connected wallet
    const origin = req.headers.origin, host = req.headers.host; if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host ?? '') || (origin && new URL(origin).host !== host) || !String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(403, ser({ ok: false, title: 'Refused', why: 'Wallet and trade calls only accept JSON posts from this terminal page.', fix: 'Use the terminal page at the address shown when the server started.' }));
  }
  try { const r = REAL_ROUTES[u.pathname] ? await REAL_ROUTES[u.pathname](body) : live ? await live.api(u.pathname, body, req.method!) : await api(u.pathname, body, req.method!); return r === undefined ? send(404, '{}') : send(200, ser(r)); }
  catch (e) { return send((e as any).status ?? 500, ser({ ok: false, title: 'Something went wrong', why: (e as Error).message, fix: 'Reload the page. Your balances are safe in this simulation.' })); }
}).listen(Number(process.env.PORT ?? 3000), '127.0.0.1', () => console.log(`${live ? 'Real-node' : 'Practice'} terminal on http://localhost:${process.env.PORT ?? 3000} (localhost only, no login: do not expose)`));
void startTelegramBot();   // practice terminal: simulated chain; fork terminal: the local anvil fork (fake ETH). Never a live chain.
// With real data on, start the launch stream at boot so the Sniper "New on Solana" board keeps filling while no page is open.
if (process.env.REAL_MARKETS === '1') setTimeout(() => { getLaunchStream().then(s => s?.start()).catch(() => {}); }, 2000);
