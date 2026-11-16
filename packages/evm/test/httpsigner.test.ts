import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpSigner, decodeEip1559, mismatch } from '../src/index.ts';
import type { Eip1559Request } from '../src/index.ts';

// test-only RLP ENCODER, so we can build a type-2 transaction with a made-up signature and check our decoder and field comparison
const bytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, '').padStart(h.replace(/^0x/, '').length + (h.replace(/^0x/, '').length % 2), '0'), 'hex'));
const n2b = (n: bigint) => n === 0n ? new Uint8Array() : bytes(n.toString(16));
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const lenp = (l: number, off: number) => l < 56 ? Uint8Array.of(off + l) : (() => { const b = n2b(BigInt(l)); return cat(Uint8Array.of(off + 55 + b.length), b); })();
const enc = (x: Uint8Array | any[]): Uint8Array => x instanceof Uint8Array ? (x.length === 1 && x[0] < 0x80 ? x : cat(lenp(x.length, 0x80), x)) : (() => { const body = cat(...x.map(enc)); return cat(lenp(body.length, 0xc0), body); })();
const WALLET = '0x' + 'ab'.repeat(20), TO = '0x' + '11'.repeat(20);
const req: Eip1559Request = { wallet: WALLET, to: TO, data: '0xdeadbeef', value: 5n, nonce: 7, chainId: 1, gasLimit: 200_000n, maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 100_000_000n };
const build = (o: Partial<Eip1559Request> = {}, sig: [bigint, bigint, bigint] = [1n, 2n ** 200n, 2n ** 201n]) => { const q = { ...req, ...o };
  return '0x02' + Buffer.from(enc([n2b(BigInt(q.chainId)), n2b(BigInt(q.nonce)), n2b(q.maxPriorityFeePerGas), n2b(q.maxFeePerGas), n2b(q.gasLimit), bytes(q.to), n2b(q.value), q.data === '0x' ? new Uint8Array() : bytes(q.data), [], n2b(sig[0]), n2b(sig[1]), n2b(sig[2])])).toString('hex'); };

test('decodes a signed type-2 transaction and agrees with the request', () => {
  const raw = build(); const d = decodeEip1559(raw);
  assert.equal(d.nonce, 7n); assert.equal(d.to, TO); assert.equal(d.value, 5n); assert.equal(d.data, '0xdeadbeef'); assert.equal(mismatch(raw, req), undefined);
});
test('every field is compared: destination, value, data, nonce, chain, gas and fees', () => {
  for (const [name, o] of Object.entries({ to: { to: '0x' + '22'.repeat(20) }, value: { value: 6n }, data: { data: '0xdeadbeee' }, nonce: { nonce: 8 }, chain: { chainId: 5 }, gas: { gasLimit: 1n }, fee: { maxFeePerGas: 1n }, tip: { maxPriorityFeePerGas: 1n } }))
    assert.ok(mismatch(build(o as any), req), `a changed ${name} must be caught`);
});
test('rejects malformed, unsigned, wrong-type and padded input', () => {
  assert.match(mismatch('0x1234', req)!, /type 2/); assert.match(mismatch('nope', req)!, /not hex/); assert.match(mismatch(build({}, [0n, 0n, 0n]), req)!, /not signed/);
  assert.match(mismatch(build() + '00', req)!, /trailing/); assert.ok(mismatch('0x02c0', req)); assert.ok(mismatch(build().slice(0, -10), req));
});
test('empty call data and zero value round-trip', () => { const q = { ...req, data: '0x', value: 0n }; assert.equal(mismatch(build({ data: '0x', value: 0n }), q), undefined); });

const serve = async (h: (body: any, auth: string | undefined) => { status?: number; json?: unknown; delayMs?: number }) => {
  const calls: any[] = [];
  const srv = createServer((rq, rs) => { let b = ''; rq.on('data', c => (b += c)); rq.on('end', async () => { const body = JSON.parse(b); calls.push({ body, auth: rq.headers.authorization }); const r = h(body, rq.headers.authorization);
    if (r.delayMs) await new Promise(x => setTimeout(x, r.delayMs)); rs.writeHead(r.status ?? 200, { 'content-type': 'application/json' }); rs.end(JSON.stringify(r.json ?? {})); }); });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r)); return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/sign`, calls, close: () => srv.close() };
};

test('HttpSigner sends the request with a bearer token and returns the verified transaction', async () => {
  const s = await serve(() => ({ json: { raw: build() } }));
  try { const raw = await new HttpSigner({ url: s.url, token: 'tok-1' }).sign(req); assert.equal(raw, build());
    assert.equal(s.calls[0].auth, 'Bearer tok-1'); assert.equal(s.calls[0].body.value, '5'); assert.equal(s.calls[0].body.wallet, WALLET); } finally { s.close(); }
});
test('HttpSigner refuses a service that changes the transaction', async () => {
  const s = await serve(() => ({ json: { raw: build({ to: '0x' + '22'.repeat(20) }) } }));
  try { await assert.rejects(new HttpSigner({ url: s.url }).sign(req), /different transaction: destination/); } finally { s.close(); }
});
test('HttpSigner reports a refusal, a missing raw field, and a timeout clearly', async () => {
  const a = await serve(() => ({ status: 403, json: { error: 'over limit' } })); const b = await serve(() => ({ json: {} })); const c = await serve(() => ({ json: { raw: build() }, delayMs: 400 }));
  try {
    await assert.rejects(new HttpSigner({ url: a.url }).sign(req), /refused \(HTTP 403\).*over limit/);
    await assert.rejects(new HttpSigner({ url: b.url }).sign(req), /without a "raw"/);
    await assert.rejects(new HttpSigner({ url: c.url, timeoutMs: 100 }).sign(req), /timed out/);
    await assert.rejects(new HttpSigner({ url: 'http://127.0.0.1:1/x', timeoutMs: 500 }).sign(req), /unreachable/);
  } finally { a.close(); b.close(); c.close(); }
  assert.throws(() => new HttpSigner({ url: 'ftp://x' }), /http/);
});
