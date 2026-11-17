/** Terminal wiring of the SDK's USD triggers: the SOL/USD feed it hands the Trader carries the observation time (so a stale rate is refused), and dollar prices from the
 *  page are turned into plain decimal strings (JS prints prices below 1e-6 as "1e-7", which the SDK rightly refuses). The trigger maths itself is tested in packages/sdk. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SolMainnet } from '../../../apps/web/solmainnet.ts';
import { usdToE18 } from '../../sdk/src/index.ts';

const fresh = () => { const m: any = new SolMainnet(mkdtempSync(join(tmpdir(), 'solusd-'))); m.solUsd = async () => m.usdCache?.v ?? null; return m; };

test('the feed reports SOL/USD with the time it was seen, 9 quote decimals and the mint decimals', async () => {
  const m = fresh(); m.decs.set('M', 5); const f = m.usdFeed();
  assert.equal(await f.quoteUsd(), null, 'no rate yet');
  m.usdCache = { v: 73.5, t: 1234 }; assert.deepEqual(await f.quoteUsd(), { price: 73.5, at: 1234 });
  assert.equal(f.quoteDecimals, 9); assert.equal(await f.tokenDecimals('M'), 5); assert.equal(f.maxAgeMs, 120_000);
});

test('dollar prices from the page become plain decimal strings; nonsense is refused', () => {
  const m = fresh();
  assert.equal(m.usdStr('0.000002399'), '0.000002399'); assert.equal(m.usdStr(1e-7), '0.0000001'); assert.equal(m.usdStr('2.5e-8'), '0.000000025');
  assert.equal(m.usdStr(String(3.5612345678901234e-6)), '0.00000356123456789', 'JS prints this with 22 decimals; cut to the 18 the SDK accepts');
  assert.equal(m.usdStr(''), undefined); assert.equal(m.usdStr(undefined), undefined);
  assert.throws(() => m.usdStr('-1e-5'), /above zero/);
});

test('a $0.0000024 trigger at SOL = $73.5 is 3.2653e-8 SOL per BONK (5 decimals) in engine units', () => {
  const e18 = usdToE18('0.0000024', 73.5, 9, 5), solPerToken = Number(e18) / 1e18 * 1e5 / 1e9;
  assert.ok(Math.abs(solPerToken / (0.0000024 / 73.5) - 1) < 1e-9, String(solPerToken));
});
