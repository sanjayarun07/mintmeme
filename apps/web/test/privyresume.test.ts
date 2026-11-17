/** Automatic trading through Privy survives a restart: a new SolMainnet on the same state folder reconnects only after Privy confirms the signer and policy are still on the wallet.
 *  Privy is the stand-in from packages/sol/test/fakeprivy.ts; the RPC points at a closed port (no chain calls are needed to connect). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SolMainnet } from '../solmainnet.ts';
import { DevSolSigner } from '../../../packages/sol/src/signer.ts';
import { fakePrivy } from '../../../packages/sol/test/fakeprivy.ts';

const RPC = 'http://127.0.0.1:9';   // nothing listens: balance reads fail quietly
test('automatic trading resumes after a restart only while Privy still allows it, signing in with that wallet keeps it, and stopping ends it for good', async () => {
  const seed = randomBytes(32), wallet = new DevSolSigner(), addr = wallet.add(seed), fp = fakePrivy({ seed }), srv = await fp.listen(), saved = { ...process.env };
  Object.assign(process.env, { PRIVY_APP_ID: fp.cfg.appId, PRIVY_APP_SECRET: fp.cfg.appSecret, PRIVY_AUTH_PRIVATE_KEY: fp.cfg.authKey, PRIVY_AUTH_KEY_ID: fp.cfg.signerId, PRIVY_SOLANA_POLICY_ID: fp.cfg.policyId, PRIVY_API_URL: srv.url });
  const dir = mkdtempSync(join(tmpdir(), 'privyresume-')), live: SolMainnet[] = [];
  const open = () => { const m = new SolMainnet(dir, RPC, ['pump']); live.push(m); return m; };
  const signIn = async (m: SolMainnet) => { const n = m.authNonce({ address: addr }); const r: any = await m.authVerify({ address: addr, signature: Buffer.from(wallet.sign(addr, new TextEncoder().encode(n.message))).toString('base64') }); return { __session: r.__setSession as string, r }; };
  try {
    const a = open(); assert.equal(await a.resumeAutomatic(), 'none', 'nothing to resume on a fresh folder');
    const s = await signIn(a); const on: any = await a.privyUse(s); assert.equal(on.signer, 'privy'); assert.ok(existsSync(join(dir, 'automatic.json')));
    // restart: the old process is gone without a clean disconnect
    const b = open(); assert.equal(await b.resumeAutomatic(), 'resumed'); const st: any = await b.status();
    assert.equal(st.signer, 'privy'); assert.equal(st.address, addr); assert.equal(st.yours, false, 'nobody holds the session yet');
    const s2 = await signIn(b); assert.equal(s2.r.signer, 'privy', 'signing in with the same wallet keeps automatic trading'); assert.equal((await b.status(s2)).yours, true);
    // revoked in Privy while the server was down: the next restart does not reconnect, and forgets it
    fp.state.delegated = false; const c = open(); assert.equal(await c.resumeAutomatic(), 'revoked'); assert.equal((await c.status() as any).connected, false); assert.ok(!existsSync(join(dir, 'automatic.json')));
    // Privy unreachable: keep the file and retry later
    fp.state.delegated = true; const d0 = open(); await d0.privyUse((await signIn(d0))); srv.close();
    const d = open(); assert.equal(await d.resumeAutomatic(), 'retrying'); assert.ok(existsSync(join(dir, 'automatic.json')));
    // stopping on purpose (disconnect) removes it, so nothing resumes
    const s3 = await signIn(d0); await d0.disconnect(s3); assert.ok(!existsSync(join(dir, 'automatic.json')));
  } finally {
    for (const m of live) await (m as any).drop?.().catch(() => {});
    srv.close(); for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved);
  }
});
