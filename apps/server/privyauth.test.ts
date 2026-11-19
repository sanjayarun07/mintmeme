/** Sign in with Privy (privyauth.ts): only a token signed by Privy's key, for this app, not expired, for a MAPPED user opens a session; the session then works like a trade key.
 *  Tokens are signed here with a throwaway P-256 key standing in for Privy's. The node test uses the local Redis (skipped when there is none) in its own namespace. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { generateKeyPairSync, sign, createHash, type KeyObject } from 'node:crypto';
import { SyncRedis } from '../../packages/core/src/index.ts';
import { verifyPrivyToken, parsePrivyUsers, privyKeys, openSession, lookupSession, closeSession } from './privyauth.ts';
import { createNode } from './node.ts';
import { practiceAccount } from './accounts.ts';

const APP = 'cmapp000000000000000000000', DID = 'did:privy:cmuser0000000000000000001', OTHER = 'did:privy:cmuser0000000000000000002';
const privy = generateKeyPairSync('ec', { namedCurve: 'P-256' }), forger = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const b64u = (x: Buffer | string) => Buffer.from(x).toString('base64url');
function jwt(claims: Record<string, unknown>, o: { key?: KeyObject; alg?: string; kid?: string } = {}) {
  const h = b64u(JSON.stringify({ alg: o.alg ?? 'ES256', typ: 'JWT', kid: o.kid ?? 'k1' })), p = b64u(JSON.stringify(claims));
  const s = sign('sha256', Buffer.from(h + '.' + p), { key: o.key ?? privy.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${h}.${p}.${b64u(s)}`;
}
const now = Math.floor(Date.now() / 1000), good = { iss: 'privy.io', aud: APP, sub: DID, iat: now, exp: now + 3600, sid: 's1' };
const keys = async () => [privy.publicKey];
const check = (t: unknown) => verifyPrivyToken(t, { appId: APP, keys });

test('a token Privy signed for this app is accepted; every other kind is refused with a plain reason', async () => {
  assert.deepEqual(await check(jwt(good)), { did: DID, exp: good.exp });
  await assert.rejects(check(jwt(good, { key: forger.privateKey })), /signature is not Privy/);
  await assert.rejects(check(jwt({ ...good, aud: 'another-app' })), /another Privy app/);
  await assert.rejects(check(jwt({ ...good, iss: 'evil.example' })), /not issued by Privy/);
  await assert.rejects(check(jwt({ ...good, exp: now - 120 })), /expired/);
  await assert.rejects(check(jwt({ ...good, sub: 'alice' })), /names no Privy user/);
  await assert.rejects(check(jwt(good, { alg: 'HS256' })), /not signed the way Privy signs/);
  await assert.rejects(check('not.a.jwt'), /not a Privy login token/);
  await assert.rejects(check(undefined), /Send the Privy access token/);
  const [h, p] = jwt(good).split('.'), tampered = `${h}.${b64u(JSON.stringify({ ...good, sub: OTHER }))}.${jwt(good).split('.')[2]}`;
  await assert.rejects(check(tampered), /signature is not Privy/, 'changing the user id breaks the signature');
});

test('Privy\'s keys are fetched for this app and cached; an unknown kid refreshes once', async () => {
  let fetches = 0; const jwk = privy.publicKey.export({ format: 'jwk' });
  const f = (async (url: string) => { fetches++; assert.equal(url, `https://auth.privy.io/api/v1/apps/${APP}/jwks.json`); return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k1', alg: 'ES256', use: 'sig' }] })); }) as any;
  const ks = privyKeys(APP, { fetch: f });
  await verifyPrivyToken(jwt(good), { appId: APP, keys: ks }); await verifyPrivyToken(jwt(good), { appId: APP, keys: ks });
  assert.equal(fetches, 1, 'cached');
  await assert.rejects(verifyPrivyToken(jwt(good, { kid: 'k9', key: forger.privateKey }), { appId: APP, keys: ks }), /signature is not Privy/); assert.equal(fetches, 2, 'unknown kid: one refresh');
});

test('PRIVY_USERS maps Privy users to accounts and refuses bad lines', () => {
  assert.deepEqual([...parsePrivyUsers(`${DID}=arun, ${OTHER}=bob`)], [[DID, 'arun'], [OTHER, 'bob']]);
  assert.throws(() => parsePrivyUsers('arun'), /did:privy/); assert.throws(() => parsePrivyUsers(`${DID}=app:user`), /did:privy/, 'no app end-user accounts');
});

test('sessions: only the hash is stored, they expire with Redis, and closing one ends it', () => {
  const m = new Map<string, string>(), r = { cmd: (...a: (string | number)[]) => { if (a[0] === 'SET') { m.set(String(a[1]), String(a[2])); assert.equal(a[3], 'EX'); assert.equal(a[4], 600); return 'OK'; } if (a[0] === 'GET') return m.get(String(a[1])) ?? null; if (a[0] === 'DEL') return m.delete(String(a[1])) ? 1 : 0; } };
  const s = openSession(r, 'ns', 'arun', DID, 600), h = createHash('sha256').update(s.session).digest();
  assert.match(s.session, /^mts_[A-Za-z0-9_-]{43}$/); assert.ok(![...m.keys(), ...m.values()].some(x => x.includes(s.session)), 'the token itself is never stored');
  assert.deepEqual(lookupSession(r, 'ns', h), { userId: 'arun', scope: 'trade' });
  closeSession(r, 'ns', s.session); assert.equal(lookupSession(r, 'ns', h), undefined);
  assert.equal(lookupSession({ cmd: () => { throw new Error('down'); } }, 'ns', h), undefined, 'Redis down: refused, not let through');
});

let up = false; try { const c = new SyncRedis('redis://127.0.0.1:6379', 1500); up = c.cmd('PING') === 'PONG'; c.close(); } catch { up = false; }
test('through a node: sign in, trade-scope calls work with the session, an unmapped user and a forged token are refused, sign out ends it', { skip: up ? false : 'no local Redis' }, async () => {
  const n = `memedesk-auth-test:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const port = await new Promise<number>(ok => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); }), url = `http://127.0.0.1:${port}`;
  const nd = await createNode({ redisUrl: 'redis://127.0.0.1:6379', namespace: n, publicUrl: url, keys: [], makeAccount: practiceAccount, leaseTtlMs: 3000, sweepMs: 60_000, requireAof: false, log: () => {},
    privyAuth: { users: parsePrivyUsers(`${DID}=alice`), ttlS: 600, verify: t => verifyPrivyToken(t, { appId: APP, keys }) } });
  await nd.listen(port);
  const post = (p: string, body: unknown, h: Record<string, string> = {}) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
  try {
    const ok = await post('/v1/auth/privy', { token: jwt(good) }); assert.equal(ok.status, 200); const s: any = await ok.json(); assert.equal(s.userId, 'alice');
    const ov = await fetch(url + '/v1/overview', { headers: { authorization: 'Bearer ' + s.session } }); assert.equal(ov.status, 200, 'the session acts for alice');
    const no = await post('/v1/auth/privy', { token: jwt({ ...good, sub: OTHER }) }); assert.equal(no.status, 403); assert.match(((await no.json()) as any).error.message, /not connected to a trading account/);
    assert.equal((await post('/v1/auth/privy', { token: jwt(good, { key: forger.privateKey }) })).status, 401);
    assert.equal((await fetch(url + '/v1/overview', { headers: { authorization: 'Bearer mts_' + 'x'.repeat(43) } })).status, 401, 'a made-up session is unknown');
    assert.equal((await fetch(url + '/v1/auth/session', { method: 'DELETE', headers: { authorization: 'Bearer ' + s.session } })).status, 200);
    assert.equal((await fetch(url + '/v1/overview', { headers: { authorization: 'Bearer ' + s.session } })).status, 401, 'signed out');
    // the SDK: MemeClient.signInWithPrivy gives a working client; signOut ends it; an unmapped user gets the server's plain refusal
    const { MemeClient } = await import('../../packages/sdk/src/index.ts');
    const sdk = await MemeClient.signInWithPrivy({ baseUrl: url, privyToken: jwt(good) }); assert.equal(sdk.account, 'alice');
    assert.equal(((await sdk.client.overview()) as any).userId, 'alice'); await sdk.client.signOut();
    await assert.rejects(sdk.client.overview(), (e: any) => e.status === 401);
    await assert.rejects(MemeClient.signInWithPrivy({ baseUrl: url, privyToken: jwt({ ...good, sub: OTHER }) }), (e: any) => e.code === 'not_mapped');
  } finally { await nd.drain?.(); const c = new SyncRedis(); try { for (const k of (c.cmd('KEYS', `${n}:*`) as string[] ?? [])) c.cmd('DEL', k); } finally { c.close(); } }
});
