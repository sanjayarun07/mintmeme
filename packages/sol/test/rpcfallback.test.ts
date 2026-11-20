/** A rate-limited Solana node falls over to a second one (Helius's plan limit, then Alchemy). Offline: fetch is a stand-in. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postRpc, SolJsonRpc } from '../src/solchain.ts';
import { solanaRpc, solanaRpcFallback } from '../../live/src/config.ts';

const node = (answers: Record<string, number[]>) => {
  const asked: string[] = [];
  const f = (async (url: string) => { asked.push(url); const s = answers[url]?.shift() ?? 200; return new Response(s === 429 ? 'Too Many Requests' : '{"jsonrpc":"2.0","id":1,"result":42}', { status: s }); }) as unknown as typeof fetch;
  return { f, asked };
};
const noWait = async () => {};

test('postRpc: a node still rate limited after one retry hands the call to the fallback node', async () => {
  const { f, asked } = node({ 'https://helius': [429, 429], 'https://alchemy': [200] });
  const r = await postRpc(f, 'https://helius', '{}', { sleep: noWait, fallbackUrl: 'https://alchemy' });
  assert.equal(r.status, 200); assert.deepEqual(asked, ['https://helius', 'https://helius', 'https://alchemy']);
});

test('postRpc: no fallback when the first node answers, or when none is given (the first node keeps its usual retries)', async () => {
  const a = node({ 'https://helius': [429, 200] });
  assert.equal((await postRpc(a.f, 'https://helius', '{}', { sleep: noWait, fallbackUrl: 'https://alchemy' })).status, 200); assert.deepEqual(a.asked, ['https://helius', 'https://helius']);
  const b = node({ 'https://helius': [429, 429, 429, 200] });
  assert.equal((await postRpc(b.f, 'https://helius', '{}', { sleep: noWait })).status, 200); assert.equal(b.asked.length, 4);
});

test('postRpc: both nodes rate limited returns the 429 (nothing ran, so nothing was sent twice)', async () => {
  const { f } = node({ 'https://helius': [429, 429], 'https://alchemy': [429, 429, 429, 429] });
  assert.equal((await postRpc(f, 'https://helius', '{}', { sleep: noWait, fallbackUrl: 'https://alchemy' })).status, 429);
});

test('SolJsonRpc uses its fallback node', async () => {
  const { f } = node({ 'https://helius': [429, 429], 'https://alchemy': [200] });
  assert.equal(await new SolJsonRpc('https://helius', f, 'https://alchemy').call('getSlot'), 42);
});

test('solanaRpcFallback: Alchemy behind Helius; none when the first node is Alchemy already; SOLANA_RPC_FALLBACK_URL wins', () => {
  assert.match(solanaRpcFallback({ HELIUS_API_KEY: 'h', ALCHEMY_API_KEY: 'a' } as any)!.url, /solana-mainnet\.g\.alchemy\.com\/v2\/a$/);
  assert.match(solanaRpcFallback({ SOLANA_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=h', ALCHEMY_API_KEY: 'a' } as any)!.url, /alchemy/);
  assert.equal(solanaRpc({ ALCHEMY_API_KEY: 'a' } as any)!.name, 'Alchemy'); assert.equal(solanaRpcFallback({ ALCHEMY_API_KEY: 'a' } as any), undefined);
  assert.equal(solanaRpcFallback({ HELIUS_API_KEY: 'h' } as any), undefined);
  assert.equal(solanaRpcFallback({ HELIUS_API_KEY: 'h', ALCHEMY_API_KEY: 'a', SOLANA_RPC_FALLBACK_URL: 'https://other/rpc' } as any)!.url, 'https://other/rpc');
});
