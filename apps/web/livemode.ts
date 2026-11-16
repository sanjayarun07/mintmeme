/** REAL-NODE mode for the terminal API: the same endpoints and response shapes as the simulated server, but every trade goes through OUR engine and
 *  EvmRpcChain to a node you run on loopback (an anvil fork of Ethereum mainnet in `npm run web:fork`). Throwaway dev wallets, fake ETH, dev-only signer.
 *  Amounts are RAW base units (wei, USDC 1e-6) exactly as the engine uses them; `overview.live.units` tells the UI how to display them.
 *  Supported: overview, quote, trade, mine, txs, notes, orders (limit buy, take profit, stop loss, bracket), TWAP orders (buy or sell USDC in equal slices over time), pause-entries.
 *  Everything else answers with an explicit "not available on the real-node terminal" message (see UNAVAILABLE) instead of simulated data. */
import { Engine, Router, Store, PolicySigner, NATIVE, OrderRunner, TwapRunner, BulkRunner, splitEqual } from '../../packages/core/src/index.ts';
import type { Intent, Order, WalletPolicy } from '../../packages/core/src/index.ts';
import { EvmRpcChain, encodeCall, decodeParams } from '../../packages/evm/src/index.ts';
import { LocalNode, newWallet, hex, big } from '../../packages/live/src/localnode.ts';
import { CastSigner } from '../../packages/live/src/enginefork.ts';
import { ETH } from '../../packages/live/src/config.ts';
import { explain, makeTxView } from './common.ts';
import { bulkView, pctToBps } from './bulkview.ts';
import type { Ctx as TgCtx } from '../telegram/handler.ts';

type Level = 'success' | 'info' | 'warn' | 'error';
const ETH1 = 10n ** 18n;
/** One account owns both dev wallets, so a multi-wallet order is one user's request and each wallet still keeps its own policy. */
const USER = 'u-main';
/** Endpoints that exist in the simulator but have no real-node implementation yet. The UI should hide these pages when `overview.unavailable` lists them. */
export const UNAVAILABLE: Record<string, string> = {
  '/api/copy': 'Copy trading', '/api/copy/leader': 'Copy trading', '/api/portfolio': 'Portfolio', '/api/alerts': 'Price alerts', '/api/signals': 'Signals',
  '/api/launch-check': 'Launch sniper', '/api/risk': 'Token safety checks', '/api/plan': 'Plan and fees', '/api/audit': 'Signing audit', '/api/wallets/automation': 'Per-wallet automation switch', '/api/market-move': 'Simulated market moves' };
const notAvailable = (what: string) => ({ ok: false, title: `${what} is not available on the real-node terminal yet`, why: 'This page still only exists in the practice simulator; nothing here is faked on the real-node port.', fix: 'Use npm run web for the simulated version, or trade and set price orders here.' });

export async function createLive(node: LocalNode) {
  const router = ETH.uniswapV2Router02.address, factory = ETH.uniswapV2Factory.address, usdc = ETH.usdc.address.toLowerCase();
  const call = (to: string, data: string) => node.call<string>('eth_call', [{ to, data }, 'latest']);
  const weth = String(decodeParams(['address'], await call(router, encodeCall('WETH()', [])))[0]).toLowerCase();
  const pair = String(decodeParams(['address'], await call(factory, encodeCall('getPair(address,address)', [weth, usdc])))[0]);
  const chainId = Number(big(await node.call('eth_chainId')));
  const signer = new CastSigner(), chain = new EvmRpcChain({ id: 'evm-fork', chainId, router, weth, pools: [{ id: 'uni:WETH-USDC', pair }], finalityDepth: 3 }, node, signer);
  const WALLETS: Record<string, { name: string; address: string }> = {};
  const policies = new Map<string, WalletPolicy>(), keys = new Map<string, string>();
  for (const [id, name] of [['w1', 'Main wallet'], ['w2', 'Second wallet']]) {
    const w = signer.add(newWallet()); await node.call('anvil_setBalance', [w.address, hex(10n * ETH1)]);
    WALLETS[id] = { name, address: w.address }; keys.set(w.address, 'dev');
    policies.set(w.address, { userId: USER, chains: ['evm-fork'], allowedVenues: ['uniswap-v2'], maxPerTx: { [NATIVE]: 5n * ETH1, [usdc]: 10n ** 12n }, dailyLimit: { [NATIVE]: 100n * ETH1, [usdc]: 10n ** 13n }, destinations: [], deviceSecret: 'dev' });
  }
  const walletOf = (id: string) => WALLETS[id]?.address ?? WALLETS.w1.address;
  const store = new Store(), engine = new Engine({ store, chain, signer: new PolicySigner(keys, policies), router: new Router(chain), platformFeeBps: 0 });
  let paused = false;
  const bulks = new Map<string, BulkRunner>(), bulkSeen = new Map<string, string>();
  const twaps = new Map<string, TwapRunner>(), twapSeen = new Map<string, string>();
  const runner = new OrderRunner({ engine, chain, clockMs: () => Date.now(), entryGate: i => !(paused && i.tokenIn === NATIVE) });
  await chain.refresh('venues');

  const notes: { id: number; level: Level; title: string; body: string; ts: number }[] = [];
  const note = (level: Level, title: string, body: string) => notes.push({ id: notes.length + 1, level, title, body, ts: Date.now() });
  const symOf = (t: string) => (t === usdc ? 'USDC' : t === NATIVE ? 'ETH' : undefined);
  const txView = makeTxView(symOf);
  const venue = () => chain.venues()[0] as any;
  const spotE18 = () => venue().spotPriceE18(usdc, NATIVE) as bigint;
  const priceNum = () => Number(spotE18()) / 1e30;                       // ETH per whole USDC
  const toE18 = (ethPerUsdc: number) => BigInt(Math.round(ethPerUsdc * 1e12)) * 10n ** 18n;   // ETH per whole USDC -> wei per base unit x1e18
  const liquidity = () => { try { return venue().quote(NATIVE, usdc, 10n ** 12n).liquidity as bigint; } catch { return 0n; } };
  const units = (raw: bigint, dec: number, frac = 6) => { const d = 10n ** BigInt(dec), w = raw / d, f = (raw % d).toString().padStart(dec, '0').slice(0, frac).replace(/0+$/, ''); return f ? `${w}.${f}` : `${w}`; };
  const isTerminal = (s: string) => ['finalized', 'failed', 'expired'].includes(s);
  const lastState = new Map<string, string>();
  const mkIntent = (b: any, key?: string): Intent => { const sell = b.side === 'sell', w = walletOf(b.walletId || 'w1');
    return { idempotencyKey: key ?? 'q-' + Math.random(), userId: USER, walletId: w, chain: 'evm-fork', tokenIn: sell ? usdc : NATIVE, tokenOut: sell ? NATIVE : usdc,
      amountIn: BigInt(b.amount || 0), minOut: 0n, slippageBps: Number(b.slippageBps ?? 300), deadline: chain.time + 600, maxFeeBps: 200, venues: ['uniswap-v2'], origin: 'manual' }; };
  const idOfWallet = (addr: string) => Object.entries(WALLETS).find(([, w]) => w.address === addr)?.[0] ?? addr;
  const view = (r: any) => ({ ...txView(r), wallet: idOfWallet(r.intent.walletId) });

  /** Advance everything in flight, run the order runner, and turn state changes into plain messages. Safe to call repeatedly. */
  let busy = false;
  async function settle() {
    if (busy) return; busy = true;
    try {
      await chain.refresh('venues');
      for (const k of [...store.records.keys()]) if (!isTerminal(store.records.get(k)!.state)) await engine.advance(k);
      // An anvil fork only produces a block when something is sent, so its clock stands still while a TWAP waits. If a TWAP is open and the last block is stale, mine one empty block so its schedule can run on real time.
      if ([...twaps.values()].some(t => !t.summary().done) && Date.now() / 1000 - chain.time > 5) { await node.call('anvil_mine', ['0x1']); await chain.refresh('head'); }
      const v0 = runner.vetoed.length; await runner.tick();
      for (const [id, b] of bulks) {
        try { await b.tick(); } catch (e) { note('error', 'Multi-wallet order problem', `Order ${id}: ${(e as Error).message}`); }
        const sm = b.summary(), sig = `${sm.filled}/${sm.failed}/${sm.skipped}/${sm.done}`;
        if (bulkSeen.get(id) !== sig) { bulkSeen.set(id, sig); if (sm.done) note(sm.refused || sm.filled === 0 ? 'warn' : 'success', 'Multi-wallet order finished', sm.refused ? `Nothing was traded: ${sm.refused}.` : `${sm.filled} of ${sm.legs.length} wallets traded${sm.skipped ? `, ${sm.skipped} skipped` : ''}${sm.failed ? `, ${sm.failed} failed` : ''}. Open the order to see each wallet.`); }
      }
      for (const [id, t] of twaps) {
        try { await t.tick(); } catch (e) { note('error', 'TWAP order problem', `Order ${id}: ${(e as Error).message}`); }
        const sm = t.summary(), sig = `${sm.filled}/${sm.failed}/${sm.skipped}/${sm.done}`;
        if (twapSeen.get(id) !== sig) { twapSeen.set(id, sig); if (sm.done) note(sm.refused || sm.filled === 0 ? 'warn' : 'success', 'TWAP order finished', sm.refused ? `Nothing was traded: ${sm.refused}.` : `${sm.filled} of ${sm.slices.length} slices traded${sm.skipped ? `, ${sm.skipped} skipped` : ''}${sm.failed ? `, ${sm.failed} failed` : ''}. Open the order to see each slice.`); }
      }
      for (const k of runner.vetoed.slice(v0)) note('warn', 'Automated buy skipped', `New automated entries are paused, so one order buy (${k.split(':')[1]}) was not sent. Exits and manual trades are unaffected.`);
      for (const r of store.records.values()) {
        const prev = lastState.get(r.key); lastState.set(r.key, r.state); if (prev === r.state || r.key.endsWith(':approve')) continue;
        const v = txView(r);
        if (r.state === 'confirmed' && r.fill) { const buy = v.side === 'buy'; note('success', v.headline.replace(' confirmed, waiting for final', '') + ' confirmed', `Received ${buy ? units(r.fill.received, 6) + ' USDC' : units(r.fill.received, 18) + ' ETH'} for ${buy ? units(r.fill.spent, 18) + ' ETH' : units(r.fill.spent, 6) + ' USDC'}. Network fee ${units(r.fill.networkFee, 18, 8)} ETH.`); }
        if (r.state === 'finalized') note('info', `${v.sym} ${v.side} is final`, 'Enough blocks have passed that this trade can no longer be reversed on this node.');
        if (r.state === 'failed' || r.state === 'expired') { const e = v.explain!; note('error', e.title, `${e.why} ${e.fix}`); }
      }
    } finally { busy = false; }
  }

  const label = (o: Order) => ({ limit_buy: 'Buy when price falls to', limit_sell: 'Sell when price rises to', take_profit: 'Take profit at', stop_loss: 'Stop loss at', trailing_stop: 'Trailing stop' }[o.kind]) + (o.triggerPriceE18 ? ` ${(Number(o.triggerPriceE18) / 1e30).toPrecision(4)} ETH per USDC` : o.trailBps ? ` ${o.trailBps / 100}% below peak` : '');
  const status = (o: Order) => ({ active: 'Watching the price', fired: 'Triggered, trade sent', cancelled: 'Cancelled', expired: 'Expired', failed: 'Stopped after repeated failures', disabled: o.reason ?? 'Disabled' } as Record<string, string>)[o.status] ?? o.status;

  async function api(path: string, body: any, method: string): Promise<unknown> {
    if (UNAVAILABLE[path]) return notAvailable(UNAVAILABLE[path]);
    switch (path) {
      case '/api/overview': {
        await chain.refresh('venues'); const wallets = [];
        for (const [id, w] of Object.entries(WALLETS)) {
          const usdcBal = await chain.balanceOf(w.address, usdc);
          wallets.push({ id, name: w.name, address: w.address, native: await chain.balanceOf(w.address, NATIVE), tokens: usdcBal > 0n ? [{ token: usdc, sym: 'USDC', bal: usdcBal }] : [],
            policy: { maxPerTx: policies.get(w.address)!.maxPerTx[NATIVE], daily: policies.get(w.address)!.dailyLimit[NATIVE], automationPaused: false }, spentToday: 0n });
        }
        return { simulated: false, live: { network: 'Local fork of Ethereum mainnet (anvil): fake ETH, nothing is sent to mainnet', chainId, units: { NATIVE: { sym: 'ETH', decimals: 18 }, [usdc]: { sym: 'USDC', decimals: 6 } }, priceUnit: 'ETH per USDC' },
          unavailable: [...new Set(Object.values(UNAVAILABLE))], block: chain.block, wallets,
          tokens: [{ address: usdc, contract: usdc, sym: 'USDC', name: 'USD Coin', blurb: 'Real Uniswap V2 WETH/USDC pool state, forked locally.', venue: 'uni:WETH-USDC', price: priceNum(), liquidity: liquidity(), open: true }], notes: notes.length };
      }
      case '/api/notes': return notes.filter(n => n.id > Number(body?.after ?? 0));
      case '/api/quote': {
        await chain.refresh('venues'); const i = mkIntent(body); const warnings: { level: Level; text: string }[] = [];
        let q; try { q = engine.d.router.route(i, 100).best; } catch (e) { return { ok: false, ...explain((e as Error).message) }; }
        const bal = await chain.balanceOf(i.walletId, i.tokenIn), minOut = q.amountOut * BigInt(10_000 - i.slippageBps) / 10_000n;
        if (i.amountIn <= 0n) warnings.push({ level: 'info', text: 'Enter an amount to see a preview.' });
        if (bal < i.amountIn) warnings.push({ level: 'error', text: `This wallet holds ${bal} but you entered ${i.amountIn}.` });
        if (q.priceImpactBps > 300) warnings.push({ level: 'warn', text: `Large price impact (${(q.priceImpactBps / 100).toFixed(2)}%). Consider a smaller amount.` });
        warnings.push({ level: 'info', text: 'Network fee is an estimate; platform fees are not collected on the real-node port.' });
        const gp = big(await node.call<string>('eth_gasPrice'));
        return { ok: true, venue: q.venue, block: q.block, expectedOut: q.amountOut, minOut, impactBps: q.priceImpactBps, fees: { platform: 0n, pool: q.venueFee, network: gp * 2n * 200_000n }, warnings };
      }
      case '/api/trade': {
        await chain.refresh('venues'); const i = mkIntent(body, 'ui-' + (body.clientId ?? Math.random())); const existing = store.records.has(i.idempotencyKey);
        const rec = await engine.submit(i); if (!existing) note('info', `${body.side === 'buy' ? 'Buy' : 'Sell'} sent`, 'Your trade was submitted to the local node. A submission is not a fill: you will get a message when it is confirmed.');
        await settle(); return view(store.records.get(rec.key)!);
      }
      case '/api/bulk': {
        const view = (id: string, b: BulkRunner) => bulkView(id, b, { token: 'USDC', walletName: w => WALLETS[idOfWallet(w)]?.name ?? w });
        if (method === 'GET') return [...bulks].map(([id, b]) => view(id, b)).reverse();
        const side = body.side === 'sell' ? 'sell' : 'buy';
        const ws: string[] = Array.isArray(body.walletIds) ? body.walletIds.filter((w: string) => WALLETS[w]) : []; if (!ws.length) return { ok: false, title: 'Pick at least one wallet', why: 'A multi-wallet order needs wallets to trade from.', fix: 'Tick one or more wallets.' };
        let total: bigint; try { total = BigInt(body.total); if (total <= 0n) throw 0; } catch { return { ok: false, title: 'Check the amount', why: 'Enter a whole number greater than zero.', fix: 'Try again with a valid amount.' }; }
        const id = 'bk' + (bulks.size + 1);
        try {
          const legs = body.amounts ? ws.map(w => ({ walletId: walletOf(w), amount: BigInt(body.amounts[w] ?? 0) })) : splitEqual(ws.map(walletOf), total);
          bulks.set(id, new BulkRunner({ engine, chain, spec: { id, userId: USER, chain: 'evm-fork', token: usdc, quoteToken: NATIVE, venues: ['uniswap-v2'], side, legs, slippageBps: Number(body.slippageBps ?? 300), maxImpactBps: pctToBps(body.maxImpactPct, 'Maximum price impact'), mode: body.mode === 'parallel' ? 'parallel' : 'sequential', onFailure: body.onFailure === 'stop' ? 'stop' : 'continue' } }));
        } catch (e) { return { ok: false, title: 'Check the multi-wallet settings', why: (e as Error).message + '.', fix: 'Adjust the setting and try again.' }; }
        note('success', 'Multi-wallet order started', 'Each wallet trades on its own. This is not all-or-nothing: if one wallet fails, the others can still trade.'); await settle(); return { ok: true, id };
      }
      case '/api/twap': {
        const view = (id: string, t: TwapRunner) => { const sm = t.summary(), sp = (t as any).d.spec; const st = sm.cancelled ? 'Cancelled' : sm.refused ? 'Refused' : sm.done ? 'Finished' : sm.slices.some(x => x.status === 'inflight') ? 'Sending a slice' : (sm.slices.find(x => x.status === 'pending')?.waiting ? 'Waiting: ' + sm.slices.find(x => x.status === 'pending')!.waiting : 'Waiting for the next slice');
          return { id, side: sp.side, tokenAddr: sp.token, token: 'USDC', walletId: idOfWallet(sp.walletId), total: sp.total, slicesTotal: sm.slices.length, intervalS: sp.intervalS, filled: sm.filled, failed: sm.failed, skipped: sm.skipped, open: sm.open, spent: sm.spent, received: sm.received, avgPrice: sm.avgPriceE18 ? Number(sm.avgPriceE18) / 1e30 : null, limitPrice: sp.limitPriceE18 ? Number(sp.limitPriceE18) / 1e30 : null, nextInS: sm.nextDueAt === undefined ? null : Math.max(0, sm.nextDueAt - chain.time), done: sm.done, cancelled: sm.cancelled, refused: sm.refused ?? null, statusText: st,
            slices: sm.slices.map(x => ({ n: x.n + 1, amount: x.amount, status: x.status, reason: x.reason ?? null, waiting: x.waiting ?? null, spent: x.spent ?? null, received: x.received ?? null, dueInS: x.dueAt - chain.time })) }; };
        if (method === 'GET') return [...twaps].map(([id, t]) => view(id, t)).reverse();
        const side = body.side === 'sell' ? 'sell' : 'buy', wid = body.walletId || 'w1', addr = walletOf(wid); await chain.refresh('venues');
        let total: bigint; try { total = BigInt(body.total); } catch { return { ok: false, title: 'Check the amount', why: 'Enter a whole number greater than zero.', fix: 'Try again with a valid amount.' }; }
        const have = await chain.balanceOf(addr, side === 'buy' ? NATIVE : usdc);
        if (BigInt(have) < total) return { ok: false, title: 'Not enough balance', why: `This wallet holds ${have} and the order needs ${total}. A TWAP order needs the whole amount up front.`, fix: 'Lower the amount or fund the wallet.' };
        const id = 'tw' + (twaps.size + 1);
        try {
          twaps.set(id, new TwapRunner({ engine, chain, spec: { id, userId: USER, walletId: addr, chain: 'evm-fork', token: usdc, quoteToken: NATIVE, venues: ['uniswap-v2'], side, total, slices: Number(body.slices), intervalS: Number(body.intervalS), slippageBps: Number(body.slippageBps ?? 500),
            limitPriceE18: body.limitPrice ? toE18(Number(body.limitPrice)) : undefined, maxSliceImpactBps: body.maxImpactPct ? Math.round(Number(body.maxImpactPct) * 100) : undefined, jitterPct: body.jitterPct ? Number(body.jitterPct) : undefined, onFailure: body.onFailure === 'stop' ? 'stop' : 'continue' } }));
        } catch (e) { return { ok: false, title: 'Check the TWAP settings', why: (e as Error).message + '.', fix: 'Adjust the setting and try again.' }; }
        note('success', 'TWAP order started', 'The first slice goes now, the rest follow on schedule. A slice that cannot go within its window is skipped and reported, never made up later.'); await settle(); return { ok: true, id };
      }
      case '/api/twap/cancel': { const t = twaps.get(body.id); if (!t) return { ok: false, title: 'No such order', why: 'That TWAP order does not exist.', fix: 'Refresh the page.' }; t.cancel(); note('info', 'TWAP order cancelled', 'Slices not yet sent were skipped. A slice already sent will still finish.'); await settle(); return { ok: true }; }
      case '/api/twap/forward': {   // local fork only: move the node's clock forward so a waiting schedule can be seen working
        const sec = Math.max(1, Math.min(86_400, Math.round(Number(body?.seconds ?? 300)))); await node.call('anvil_mine', ['0x4']); await settle();
        await node.call('evm_increaseTime', [hex(BigInt(sec))]); await node.call('anvil_mine', ['0x1']); await chain.refresh('head'); await settle(); return { ok: true, time: chain.time };
      }
      case '/api/mine': await node.call('anvil_mine', [hex(BigInt(Number(body?.n ?? 1)))]); await settle(); return { block: chain.block };
      case '/api/txs': return [...store.records.values()].filter(r => !r.key.endsWith(':approve')).map(view).reverse();
      case '/api/pause-entries': { if (method === 'POST') { paused = !!body.paused; note(paused ? 'warn' : 'success', paused ? 'New automated entries paused' : 'Automated entries resumed', paused ? 'Automated buys are blocked. Exits, stop losses, manual trades and your wallets are unchanged.' : 'Automated strategies can open new positions again, within their limits.'); } return { paused }; }
      case '/api/orders': {
        if (method === 'GET') return [...runner.orders.orders.values()].map(o => ({ walletId: idOfWallet(o.walletId), tokenAddr: o.token, attempts: o.attempts, id: o.id, label: label(o), kind: o.kind, token: 'USDC', amount: o.amount, status: o.status, statusText: status(o), oco: o.ocoGroup, expiresIn: o.expiresAt - chain.time }));
        if (body.kind === 'limit_sell') return { ok: false, title: 'This order type is not available on the real-node terminal', why: 'Limit sells have not been exercised on a real chain yet.', fix: 'Use a take profit, trailing stop, stop loss, limit buy or bracket.' };
        const trail = Number(body.trailPct); if (body.kind === 'trailing_stop' && !(trail > 0 && trail < 100)) return { ok: false, title: 'Trail must be between 0 and 100 percent', why: 'The trailing stop sells when the price falls this far below its highest point.', fix: 'Enter a number such as 10.' };
        const wid = body.walletId || 'w1', addr = walletOf(wid); await chain.refresh('venues');
        const mk = (id: string, kind: Order['kind'], price: number, extra: Partial<Order> = {}): Order => ({ id, userId: USER, walletId: addr, chain: 'evm-fork', token: usdc, quoteToken: NATIVE, kind, amount: BigInt(body.amount),
          triggerPriceE18: toE18(price), expiresAt: chain.time + 7 * 86400, maxQuoteAgeMs: 60_000, minLiquidity: 10n ** 18n, maxDeviationBps: 1000, maxAttempts: 2, slippageBps: Number(body.slippageBps ?? 50), venues: ['uniswap-v2'], status: 'active', attempts: 0, ...extra });
        const id = 'o' + (runner.orders.orders.size + 1);
        try {
          if (body.kind === 'bracket') { await runner.place(mk(id + 'a', 'take_profit', Number(body.tp), { ocoGroup: id })); await runner.place(mk(id + 'b', 'stop_loss', Number(body.sl), { ocoGroup: id })); }
          else if (body.kind === 'trailing_stop') await runner.place(mk(id, 'trailing_stop', 0, { triggerPriceE18: undefined, trailBps: Math.round(trail * 100) }));
          else await runner.place(mk(id, body.kind, Number(body.price)));
        } catch (e) { return { ok: false, title: 'Not enough free balance', why: `The funds needed for this order are already reserved by another order, or the wallet does not hold enough. (${(e as Error).message})`, fix: 'Cancel an order or lower the amount.' }; }
        note('success', 'Order placed', 'It will only trigger when the real pool price meets the condition and the pool can actually fill it.'); await settle(); return { ok: true };
      }
      case '/api/orders/cancel': { runner.cancel(body.id); const o = runner.orders.orders.get(body.id); if (o?.ocoGroup) for (const s of runner.orders.orders.values()) if (s.ocoGroup === o.ocoGroup && s.status === 'active') runner.cancel(s.id); note('info', 'Order cancelled', 'The reserved balance is free again.'); return { ok: true }; }
    }
    return undefined;
  }
  /** Telegram trading context for the fork terminal: the first dev wallet, USDC against ETH, amounts as plain decimals ("0.01" ETH to buy, "5" USDC to sell). Same engine, same wallet policy as the web. */
  const parseUnits = (text: string, dec: number) => {
    const m = /^(\d+)(?:\.(\d+))?$/.exec(text.replace(/,/g, '')); if (!m) throw new Error('the amount must be a number such as 0.01.');
    if ((m[2] ?? '').length > dec) throw new Error(`the amount can have at most ${dec} decimal places.`); return BigInt(m[1]) * 10n ** BigInt(dec) + BigInt((m[2] ?? '').padEnd(dec, '0') || '0');
  };
  const telegramCtx = (userId: string): TgCtx => ({ userId, walletId: 'w1', chain: 'evm-fork', native: NATIVE, autoTrade: false, quickBuy: ETH1 / 100n, now: () => chain.time,
    amount: (text, side) => parseUnits(text, side === 'buy' ? 18 : 6),
    async submit(i) {
      const buy = i.tokenIn === NATIVE, tok = (buy ? i.tokenOut : i.tokenIn).toLowerCase();
      if (tok !== 'usdc' && tok !== usdc) throw new Error('Unknown token. The fork terminal trades USDC only: try /buy USDC 0.01 (ETH to spend) or /sell USDC 5.');
      await chain.refresh('venues'); const intent = mkIntent({ side: buy ? 'buy' : 'sell', walletId: 'w1', amount: String(i.amountIn), slippageBps: i.slippageBps }, i.idempotencyKey); intent.origin = 'telegram';
      const existing = store.records.has(intent.idempotencyKey), rec = await engine.submit(intent);
      if (!existing) note('info', `Telegram ${buy ? 'buy' : 'sell'} sent`, 'A linked Telegram chat sent this trade to the local node. It goes through the same wallet limits as the web.');
      await node.call('anvil_mine', ['0x4']);                     // an anvil fork only mines when told to: give the trade enough blocks to finalize
      let r = store.records.get(rec.key) ?? rec; for (let k = 0; k < 6 && !isTerminal(r.state); k++) { await settle(); r = store.records.get(rec.key) ?? r; if (!isTerminal(r.state)) await new Promise(res => setTimeout(res, 400)); }
      if (r.state === 'failed') { const e = explain(r.failure); return { state: `failed (${e.title}. ${e.why} ${e.fix})` }; }
      return { state: r.state };
    } });
  return { api, settle, chain, engine, store, runner, wallets: WALLETS, usdc, node, telegramCtx };
}
