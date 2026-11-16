import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBot } from './bot.ts';
import { BuyBot } from './buybot.ts';
import { WalletBot, WALLETBOT_LIMITS } from './walletbot.ts';

const TOKEN = '777:SECRET', TOK = '0x' + 'ab'.repeat(20), ADDR = '0x' + '11'.repeat(20);
/** Fake Bot API: answers getUpdates from a queue, getChatMember from a status map, records everything. */
function fake(updates: any[], members: Record<number, string> = {}, memberFails = false) {
  const calls: { method: string; body: any }[] = [];
  const fetchFn = (async (url: string, init: any) => {
    const method = String(url).split('/').pop()!, body = JSON.parse(init.body); calls.push({ method, body });
    const ok = (result: any) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    if (method === 'getUpdates') return ok(updates.splice(0));
    if (method === 'getChatMember') return memberFails ? new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 400 }) : ok({ status: members[body.user_id] ?? 'member' });
    return ok(true);
  }) as unknown as typeof fetch;
  return { fetchFn, calls, sent: () => calls.filter(c => c.method === 'sendMessage') };
}
const grp = (id: number, from: number, text: string) => ({ update_id: id, message: { message_id: id, chat: { id: -100, type: 'supergroup' }, from: { id: from }, text } });
const dm = (id: number, chat: number, text: string) => ({ update_id: id, message: { message_id: id, chat: { id: chat, type: 'private' }, from: { id: chat }, text } });
const wallet = (over: Partial<ConstructorParameters<typeof WalletBot>[0]> = {}) => new WalletBot({ balanceOf: async () => 1.5, priceOf: async () => 600, ...over });

test('group: an admin (per Telegram getChatMember) can change the Buy Bot; a plain member cannot; the bot name suffix is accepted', async () => {
  const f = fake([grp(1, 5, `/buybot@mybot add ${TOK}`), grp(2, 6, '/buybot min 999'), grp(3, 6, '/buybot status')], { 5: 'administrator', 6: 'member' });
  const buy = new BuyBot({ sink: () => {} }); const bot = new TelegramBot({ token: TOKEN, fetchFn: f.fetchFn, links: new Map(), buyBot: buy, pollTimeoutS: 0 });
  assert.equal(await bot.pollOnce(), 3); const t = f.sent().map(c => c.body.text);
  assert.match(t[0], /Watching/); assert.match(t[1], /Only group admins/); assert.match(t[2], /1\/2 tokens/); assert.equal(buy.config('-100')!.minUsd, 100, 'the member could not change it');
  assert.ok(f.sent().every(c => c.body.chat_id === -100));
});
test('group: the creator counts as admin; if Telegram cannot be asked the sender is NOT an admin (fails closed)', async () => {
  const f = fake([grp(1, 9, `/buybot add ${TOK}`)], { 9: 'creator' }); const buy = new BuyBot({ sink: () => {} });
  await new TelegramBot({ token: TOKEN, fetchFn: f.fetchFn, links: new Map(), buyBot: buy, pollTimeoutS: 0 }).pollOnce(); assert.ok(buy.config('-100'));
  const g = fake([grp(1, 9, `/buybot add ${TOK}`)], {}, true); const buy2 = new BuyBot({ sink: () => {} });
  await new TelegramBot({ token: TOKEN, fetchFn: g.fetchFn, links: new Map(), buyBot: buy2, pollTimeoutS: 0 }).pollOnce();
  assert.match(g.sent()[0].body.text, /Only group admins/); assert.equal(buy2.config('-100'), undefined);
});
test('group: any other message or command (including /buy and /wallet) is ignored and nothing is sent; with no Buy Bot configured even /buybot is ignored', async () => {
  const f = fake([grp(1, 5, '/buy TOK 100'), grp(2, 5, '/wallet list'), grp(3, 5, 'hello /buybot status')], { 5: 'administrator' });
  const bot = new TelegramBot({ token: TOKEN, fetchFn: f.fetchFn, links: new Map(), buyBot: new BuyBot({ sink: () => {} }), walletBot: wallet(), pollTimeoutS: 0 });
  assert.equal(await bot.pollOnce(), 0); assert.equal(f.sent().length, 0);
  const h = fake([grp(1, 5, '/buybot status')], { 5: 'administrator' }); assert.equal(await new TelegramBot({ token: TOKEN, fetchFn: h.fetchFn, links: new Map(), pollTimeoutS: 0 }).pollOnce(), 0);
});
test('private /wallet works without a linked account, is read-only, and a pasted private key is still deleted first', async () => {
  const key = '0x' + 'ab'.repeat(32);
  const f = fake([dm(1, 42, `/wallet add bsc ${ADDR} main`), dm(2, 42, '/wallet balance'), dm(3, 42, `/wallet add bsc ${key}`)]);
  const bot = new TelegramBot({ token: TOKEN, fetchFn: f.fetchFn, links: new Map(), walletBot: wallet(), pollTimeoutS: 0 }); await bot.pollOnce();
  const t = f.sent().map(c => c.body.text); assert.match(t[0], /Watching 0x1111…1111 on bsc as "main"/); assert.match(t[1], /main \(bsc\): 1.5 BNB/);
  assert.ok(f.calls.some(c => c.method === 'deleteMessage'), 'the key message was deleted'); assert.match(t[2], /deleted your message/);
});

test('wallet bot: only bsc, ethereum, arbitrum; only public 0x addresses; limits and duplicates are explained; a failed lookup says so', async () => {
  const w = wallet({ balanceOf: async () => { throw new Error('rpc down'); } });
  assert.match(await w.command('u', '/wallet add solana x'), /Pick a chain/); assert.match(await w.command('u', '/wallet add bsc nope'), /public wallet address/);
  assert.match(await w.command('u', `/wallet add bsc ${ADDR} a`), /Watching/); assert.match(await w.command('u', `/wallet add bsc ${ADDR} b`), /already watch/);
  assert.match(await w.command('u', `/wallet add ethereum ${'0x' + '22'.repeat(20)} a`), /name is already used/);
  assert.match(await w.command('u', '/wallet balance'), /balance unavailable/); assert.equal(w.failures, 1);
  for (let i = 1; i < WALLETBOT_LIMITS.wallets; i++) await w.command('u', `/wallet add arbitrum 0x${String(i).padStart(40, '3')} n${i}`);
  assert.match(await w.command('u', `/wallet add bsc 0x${'4'.repeat(40)} extra`), /the limit \(5\)/);
  assert.match(await w.command('u', '/wallet remove a'), /Removed/); assert.match(await w.command('u', '/wallet remove nobody'), /No wallet with that name/);
  assert.match(await w.command('other', '/wallet list'), /No wallets yet/, 'users never see each other');
});
test('wallet bot alerts: fire once when crossed, then disarm; an unknown price leaves them armed; limits and bad input are explained', async () => {
  let price: number | null = 600; const sent: string[] = [];
  const w = wallet({ priceOf: async () => price, sink: (u, t) => { sent.push(u + '|' + t); } });
  assert.match(await w.command('u', '/wallet alert add bsc native above 700'), /Alert #1 set/); assert.match(await w.command('u', '/wallet alert add bsc native sideways 7'), /above or below/);
  assert.match(await w.command('u', '/wallet alert add bsc native above -5'), /greater than zero/); assert.match(await w.command('u', '/wallet alert add bsc 0xnothex above 5'), /native/);
  assert.equal(await w.check(), 0); price = null; assert.equal(await w.check(), 0, 'unknown price: nothing fires'); assert.match(await w.command('u', '/wallet alert list'), /waiting/);
  price = 701; assert.equal(await w.check(), 1); assert.match(sent[0], /BNB on bsc is 701 USD, above your 700/); assert.equal(await w.check(), 0, 'fires once');
  assert.match(await w.command('u', '/wallet alert list'), /fired/); assert.match(await w.command('u', '/wallet alert remove 1'), /Removed/);
  await w.command('u', '/wallet alert add ethereum native below 100'); price = 90; assert.equal(await w.check(), 1);
  for (let i = 0; i < WALLETBOT_LIMITS.alerts; i++) await w.command('v', '/wallet alert add bsc native above 1');
  assert.match(await w.command('v', '/wallet alert add bsc native above 1'), /the limit \(10\)/);
});
test('wallet bot: a failing sink or price lookup is counted and never thrown', async () => {
  const w = wallet({ priceOf: async () => 800, sink: () => { throw new Error('blocked'); } }); await w.command('u', '/wallet alert add bsc native above 1');
  assert.equal(await w.check(), 0); assert.equal(w.failures, 1);
  const x = wallet({ priceOf: async () => { throw new Error('feed down'); } }); await x.command('u', '/wallet alert add bsc native above 1'); assert.equal(await x.check(), 0); assert.equal(x.failures, 1);
});

/* ---------- feeds: Buy Bot + Wallet Bot wiring and real read-only lookups (all fakes, nothing touches the network) ---------- */
import { communityStep, startCommunity, realLookups, pickPrice } from './community.ts';
import type { FeedTrade, FeedToken } from '../../packages/live/src/tradefeed.ts';

const TOKA = '0x' + 'aa'.repeat(20), TOKB = '0x' + 'bb'.repeat(20);
const ft = (contract: string, o: Partial<FeedTrade> = {}): FeedTrade => ({ t: '2026-11-15T10:00:00Z', side: 'buy', wallet: '0x' + '99'.repeat(20), usd: 500, tx: '0xt', key: 'k' + Math.random(), tokenId: 'ethereum:' + contract, contract, sym: 'AAA', chain: 'ethereum', pool: '0xpool', chg: null, fresh: true, ...o } as FeedTrade);
const tok = (contract: string): FeedToken => ({ id: 'ethereum:' + contract, sym: 'AAA', chain: 'ethereum', contract, pool: '0xpool' + contract.slice(2, 6), pad: null });

test('feeds: only tokens a group watches are polled; fresh trades are posted once; a watched token missing from the real list is reported, not silently ignored', async () => {
  const posts: [string, string][] = []; const buy = new BuyBot({ sink: (g, t) => { posts.push([g, t]); } }); buy.command('g1', true, `/buybot add ${TOKA}`); buy.command('g1', true, `/buybot add ${'0x' + 'cc'.repeat(20)}`);
  const polled: string[][] = []; const trade = ft(TOKA);
  const res = await communityStep({ buyBot: buy, walletBot: wallet(), tokens: () => [tok(TOKA), tok(TOKB)], pollCycle: async t => { polled.push(t.map(x => x.contract)); return { fresh: [trade], polled: t.length, errors: 0 }; } });
  assert.deepEqual(polled, [[TOKA]], 'TOKB is not watched by anyone, so it is never polled'); assert.equal(res.posted, 1); assert.equal(posts.length, 1); assert.equal(posts[0][0], 'g1'); assert.deepEqual(res.unknownWatched, ['0x' + 'cc'.repeat(20)]);
  await communityStep({ buyBot: buy, walletBot: wallet(), tokens: () => [tok(TOKA)], pollCycle: async () => ({ fresh: [trade], polled: 1, errors: 0 }) }); assert.equal(posts.length, 1, 'the same trade is never posted twice');
});
test('feeds: with no group watching anything the feed is not polled at all; price alerts are still checked', async () => {
  let polls = 0; const sent: string[] = []; const w = wallet({ priceOf: async () => 800, sink: (_u, t) => { sent.push(t); } }); await w.command('u', '/wallet alert add bsc native above 700');
  const res = await communityStep({ buyBot: new BuyBot({ sink: () => {} }), walletBot: w, tokens: () => [tok(TOKA)], pollCycle: async () => { polls++; return { fresh: [], polled: 0, errors: 0 }; } });
  assert.equal(polls, 0); assert.equal(res.alerts, 1); assert.equal(sent.length, 1);
});
test('feeds: the loop reports each result, survives a failing cycle, and stops when told to', async () => {
  const results: number[] = [], errors: string[] = []; let n = 0; const buy = new BuyBot({ sink: () => {} }); buy.command('g', true, `/buybot add ${TOKA}`);
  const stop = startCommunity({ buyBot: buy, walletBot: wallet(), tokens: () => [tok(TOKA)], pollCycle: async () => { if (n++ === 0) throw new Error('feed down'); return { fresh: [], polled: 1, errors: 0 }; } }, { everyMs: 5, onResult: r => results.push(r.polled), onError: e => errors.push(e.message) });
  for (let i = 0; i < 100 && results.length < 2; i++) await new Promise(r => setTimeout(r, 10)); stop();
  assert.deepEqual(errors, ['feed down']); assert.ok(results.length >= 2); const seen = results.length; await new Promise(r => setTimeout(r, 40)); assert.equal(results.length, seen, 'stopped means stopped');
});
test('lookups: balance comes from eth_getBalance in whole coins; a chain with no node is "unavailable" (null), never a guessed endpoint; odd node answers are null', async () => {
  const calls: any[] = []; const L = realLookups({ rpc: { bsc: { call: async (m: string, p: unknown[] = []) => { calls.push([m, p]); return '0x' + (3n * 10n ** 18n / 2n).toString(16); } }, ethereum: { call: async () => 'nonsense' } }, wrappedNative: {} });
  assert.equal(await L.balanceOf('bsc', ADDR), 1.5); assert.deepEqual(calls[0], ['eth_getBalance', [ADDR, 'latest']]);
  assert.equal(await L.balanceOf('arbitrum', ADDR), null); assert.equal(await L.balanceOf('ethereum', ADDR), null);
});
test('lookups: price takes the deepest pool on the right chain; native ETH uses the Ethereum wrapped-native pool for both Ethereum and Arbitrum, BNB the BSC one; failures are null', async () => {
  const urls: string[] = []; const body = { pairs: [{ chainId: 'bsc', priceUsd: '1.1', liquidity: { usd: 10 } }, { chainId: 'bsc', priceUsd: '600.5', liquidity: { usd: 9_000_000 } }, { chainId: 'ethereum', priceUsd: '3000.25', liquidity: { usd: 50 } }, { chainId: 'ethereum', priceUsd: 'junk', liquidity: { usd: 99_999_999 } }] };
  const fetchFn = (async (u: string) => { urls.push(String(u)); return new Response(JSON.stringify(body), { status: 200 }); }) as unknown as typeof fetch;
  const L = realLookups({ rpc: {}, wrappedNative: { ethereum: '0xWETH', bsc: '0xWBNB' }, fetchFn });
  assert.equal(await L.priceOf('bsc', 'native'), 600.5); assert.ok(urls[0].endsWith('/0xWBNB'));
  assert.equal(await L.priceOf('arbitrum', 'native'), null, 'the Ethereum pool list has a junk top pool: no price rather than a wrong one'); assert.ok(urls[1].endsWith('/0xWETH'));
  assert.equal(pickPrice({ pairs: [{ chainId: 'ethereum', priceUsd: '3000.25', liquidity: { usd: 50 } }] }, 'ethereum'), 3000.25); assert.equal(pickPrice({}, 'bsc'), null);
  const down = realLookups({ rpc: {}, wrappedNative: { ethereum: '0xW' }, fetchFn: (async () => new Response('', { status: 503 })) as unknown as typeof fetch }); assert.equal(await down.priceOf('ethereum', 'native'), null);
  assert.equal(await realLookups({ rpc: {}, wrappedNative: {}, fetchFn }).priceOf('bsc', 'native'), null, 'no wrapped-native address known: unavailable');
});
test('post(): the bot can message a group or a user, splits long text, and never leaks its token in an error', async () => {
  const f = fake([]); const bot = new TelegramBot({ token: TOKEN, fetchFn: f.fetchFn, links: new Map(), pollTimeoutS: 0 });
  await bot.post(-100, 'x'.repeat(5000)); assert.deepEqual(f.sent().map(c => c.body.text.length), [4096, 904]); assert.ok(f.sent().every(c => c.body.chat_id === -100 && c.body.disable_web_page_preview === true));
  const bad = new TelegramBot({ token: TOKEN, fetchFn: (async () => new Response(JSON.stringify({ ok: false, description: `forbidden ${TOKEN}` }), { status: 403 })) as unknown as typeof fetch, links: new Map() });
  await assert.rejects(bad.post(1, 'hi'), (e: Error) => !e.message.includes('SECRET') && /forbidden/.test(e.message));
});
