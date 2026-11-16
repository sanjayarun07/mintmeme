import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimChain, SharedFeed } from '../src/index.ts';
import type { ChainPort } from '../src/index.ts';

const mk = (ttlMs?: number) => {
  const chain = new SimChain(); const calls: string[] = [];
  (chain as ChainPort).refresh = async (w: 'head' | 'venues') => { calls.push(w); };
  let now = 0; const feed = new SharedFeed(chain, { ttlMs, clockMs: () => now }) as unknown as ChainPort & { feed: SharedFeed };
  return { chain, feed, calls, tick: (ms: number) => { now += ms; } };
};

test('many callers inside the ttl cause one upstream venues refresh', async () => {
  const w = mk(500); for (let i = 0; i < 50; i++) await w.feed.refresh!('venues');
  assert.deepEqual(w.calls, ['venues']); assert.equal(w.feed.feed.stats.asked, 50); assert.equal(w.feed.feed.stats.upstream, 1);
});
test('after the ttl passes the next call reloads', async () => {
  const w = mk(500); await w.feed.refresh!('venues'); w.tick(499); await w.feed.refresh!('venues'); assert.equal(w.calls.length, 1);
  w.tick(2); await w.feed.refresh!('venues'); assert.equal(w.calls.length, 2);
});
test('callers that arrive while a refresh is running share it', async () => {
  const chain = new SimChain(); let n = 0, release!: () => void; const wait = new Promise<void>(r => (release = r));
  (chain as ChainPort).refresh = async () => { n++; await wait; };
  const feed = new SharedFeed(chain, { ttlMs: 0, clockMs: () => 0 }) as unknown as ChainPort;
  const all = Promise.all([feed.refresh!('venues'), feed.refresh!('venues'), feed.refresh!('venues')]); release(); await all; assert.equal(n, 1);
});
test('head refreshes are never reused (the engine needs new blocks promptly)', async () => {
  const w = mk(500); await w.feed.refresh!('head'); await w.feed.refresh!('head'); assert.deepEqual(w.calls, ['head', 'head']);
});
test('a failed refresh is not remembered: the next caller tries again', async () => {
  const chain = new SimChain(); let n = 0; (chain as ChainPort).refresh = async () => { n++; if (n === 1) throw new Error('rpc down'); };
  const feed = new SharedFeed(chain, { ttlMs: 500, clockMs: () => 0 }) as unknown as ChainPort;
  await assert.rejects(feed.refresh!('venues'), /rpc down/); await feed.refresh!('venues'); assert.equal(n, 2);
});
test('everything else goes straight to the wrapped chain, including writes to time and block', async () => {
  const w = mk(); w.feed.time = 123; assert.equal(w.chain.time, 123); assert.equal(w.feed.id, w.chain.id); assert.equal(w.feed.venues().length, w.chain.venues().length);
});
