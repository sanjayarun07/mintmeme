import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BuyBot, BUYBOT_LIMITS, formatBuyMessage } from './buybot.ts';
import { WhaleBot, whaleMatch, DEFAULT_WHALE } from './whalebot.ts';
import type { FeedTrade } from '../../packages/live/src/tradefeed.ts';

const TOK = '0x' + 'ab'.repeat(20), TOK2 = '0x' + 'cd'.repeat(20), TOK3 = '0x' + 'ef'.repeat(20), W1 = '0x' + '11'.repeat(20), W2 = '0x' + '22'.repeat(20);
let n = 0; const tr = (o: Partial<FeedTrade> = {}): FeedTrade => ({ t: '2026-11-14T10:00:00Z', side: 'buy', wallet: W1, usd: 500, tx: '0xt' + n, key: 'k' + n++, tokenId: 'ethereum:' + TOK, contract: TOK, sym: 'PEPE', chain: 'ethereum', pool: 'p', chg: 12.34, fresh: true, ...o });
const rig = () => { const sent: [string, string][] = []; const bot = new BuyBot({ sink: (g, t) => { sent.push([g, t]); } }); return { bot, sent }; };

test('only admins change settings; anyone can read status', () => {
  const { bot } = rig(); assert.match(bot.command('g1', false, `/buybot add ${TOK}`), /Only group admins/); assert.match(bot.command('g1', true, `/buybot add ${TOK}`), /Watching/);
  assert.match(bot.command('g1', false, '/buybot status'), /1\/2 tokens/); assert.match(bot.command('g1', false, '/buybot min 5'), /Only group admins/); assert.equal(bot.config('g1')!.minUsd, 100);
});
test('the free tier is two tokens (the one documented number); a third is refused with the limit stated; duplicates and junk are refused', () => {
  const { bot } = rig(); assert.equal(BUYBOT_LIMITS.free, 2);
  bot.command('g', true, `/buybot add ${TOK}`); bot.command('g', true, `/buybot add ${TOK2}`);
  assert.match(bot.command('g', true, `/buybot add ${TOK3}`), /limit \(2\)/); assert.match(bot.command('g', true, `/buybot add ${TOK}`), /already watched/); assert.match(bot.command('g', true, '/buybot add hello'), /contract address/);
  assert.match(bot.command('g', true, '/buybot tier premium'), /Tier set/); assert.match(bot.command('g', true, `/buybot add ${TOK3}`), /Watching/);
  assert.match(bot.command('g', true, '/buybot tier free'), /Remove tokens first/);
});
test('buys at or above the minimum are posted once; sells are off by default; ignored wallets and baseline trades are skipped; message has no link', async () => {
  const { bot, sent } = rig(); bot.command('g', true, `/buybot add ${TOK}`); bot.command('g', true, '/buybot min 200');
  const t = tr({ usd: 500 }); assert.equal(await bot.handleTrade(t, 0), 1); assert.equal(await bot.handleTrade(t, 1), 0, 'same trade never twice');
  assert.equal(await bot.handleTrade(tr({ usd: 150 }), 0), 0, 'below minimum'); assert.equal(await bot.handleTrade(tr({ side: 'sell', usd: 900 }), 0), 0, 'sells off by default');
  bot.command('g', true, '/buybot sells on'); assert.equal(await bot.handleTrade(tr({ side: 'sell', usd: 900 }), 0), 1);
  bot.command('g', true, `/buybot ignore ${W2}`); assert.equal(await bot.handleTrade(tr({ wallet: W2 }), 0), 0); assert.equal(await bot.handleTrade(tr({ fresh: false }), 0), 0, 'a feed baseline is never announced');
  assert.equal(await bot.handleTrade(tr({ contract: TOK3 }), 0), 0, 'a token the group does not watch');
  assert.ok(sent.every(([, m]) => !/https?:|www\.|t\.me/i.test(m))); assert.match(sent[0][1], /BUY PEPE on Ethereum\n\$500 by 0x1111…1111 \| 24h price change \+12\.3%/);
});
test('emoji count scales with size (1 to 30) and token names from the feed are sanitised', () => {
  assert.equal(formatBuyMessage(tr({ usd: 10 }), { emojiStepUsd: 50 }).split('\n')[0], '🟢'); assert.equal([...formatBuyMessage(tr({ usd: 260 }), { emojiStepUsd: 50 }).split('\n')[0]].length, 5);
  assert.equal([...formatBuyMessage(tr({ usd: 1e6 }), { emojiStepUsd: 50 }).split('\n')[0]].length, 30); assert.ok(formatBuyMessage(tr({ side: 'sell' }), { emojiStepUsd: 50 }).startsWith('🔴'));
  const m = formatBuyMessage(tr({ sym: 'EVIL\n‮FREE MONEY CLICK' }), { emojiStepUsd: 50 }); assert.equal(m.split('\n').length, 3, 'newlines in a token name cannot add lines'); assert.ok(!m.includes('‮'));
});
test('rate limit per group, and a failing sink is counted and never throws', async () => {
  const sent: string[] = []; const bot = new BuyBot({ sink: (_g, t) => { sent.push(t); }, maxPerWindow: 2, windowS: 60 }); bot.command('g', true, `/buybot add ${TOK}`);
  let posted = 0; for (let i = 0; i < 5; i++) posted += await bot.handleTrade(tr(), 1000); assert.equal(posted, 2); assert.equal(await bot.handleTrade(tr(), 1000 + 61_000), 1, 'window moves on');
  const bad = new BuyBot({ sink: () => { throw new Error('telegram down'); } }); bad.command('g', true, `/buybot add ${TOK}`); assert.equal(await bad.handleTrade(tr(), 0), 0); assert.equal(bad.failures, 1);
  assert.deepEqual([...bot.watched()], [TOK]);
});

test('whale: size, side and chain filters; a watched wallet alerts at its own lower minimum; matching ignores address case', () => {
  const c = { ...DEFAULT_WHALE, minUsd: 10_000 }; assert.equal(whaleMatch(tr({ usd: 9_999 }), c), null); assert.equal(whaleMatch(tr({ usd: 10_000 }), c), 'size');
  assert.equal(whaleMatch(tr({ usd: 20_000, side: 'sell' }), { ...c, sides: ['buy'] }), null); assert.equal(whaleMatch(tr({ usd: 20_000 }), { ...c, chains: ['solana'] }), null); assert.equal(whaleMatch(tr({ usd: 20_000 }), { ...c, chains: ['ethereum'] }), 'size');
  const w = { ...c, watched: [W1.toUpperCase().replace('0X', '0x')], watchedMinUsd: 100 }; assert.equal(whaleMatch(tr({ usd: 150 }), w), 'watched wallet'); assert.equal(whaleMatch(tr({ usd: 50 }), w), null, 'dust from a watched wallet is ignored');
});
test('whale bot: alerts each user once, only fresh trades, per-user settings, failing sink does not throw', async () => {
  const sent: [string, string][] = []; const bot = new WhaleBot({ sink: (u, t) => { sent.push([u, t]); } }); bot.set('u1', { minUsd: 1000 }); bot.set('u2', { minUsd: 100_000 });
  const t = tr({ usd: 5000 }); assert.equal(await bot.handleTrade(t, 0), 1); assert.equal(await bot.handleTrade(t, 1), 0); assert.equal(sent[0][0], 'u1'); assert.match(sent[0][1], /WHALE BUY PEPE on Ethereum\n\$5,000 by 0x1111…1111 \(large trade\)/);
  assert.equal(await bot.handleTrade(tr({ usd: 5000, fresh: false }), 0), 0); assert.throws(() => bot.set('u3', { minUsd: -5 }), /positive/);
  const bad = new WhaleBot({ sink: () => { throw new Error('x'); } }); bad.set('u', { minUsd: 1 }); assert.equal(await bad.handleTrade(tr(), 0), 0); assert.equal(bad.failures, 1);
});
