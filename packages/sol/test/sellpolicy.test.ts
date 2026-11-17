/** Regression: on 2026-11-17 the first mainnet limit sell fired three times and was refused each time with "signer policy: exceeds per-tx limit". The policy signer's limits are keyed by
 *  token and written in SOL; a sell spends the token being sold, which had no entry, so every order-fired sell was denied (a confirmed market sell was fine: it opens the entry itself).
 *  The terminal now opens the sold token's entry for active sell-side orders and never for buys. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PolicySigner, PolicyRejection } from '../../core/src/index.ts';
import type { WalletPolicy, SignRequest } from '../../core/src/index.ts';
import { SolMainnet } from '../../../apps/web/solmainnet.ts';

const NATIVE = 'NATIVE', TOK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', OTHER = 'So11111111111111111111111111111111111111112', W = 'wallet1';
const policy = (): WalletPolicy => ({ userId: 'u1', chains: ['sol-main'], allowedVenues: ['pump', 'jupiter'], maxPerTx: { [NATIVE]: 10_000_000n }, dailyLimit: { [NATIVE]: 50_000_000n }, destinations: [], deviceSecret: 'x' });
const sell = (n: number): SignRequest => ({ userId: 'u1', walletId: W, chain: 'sol-main', kind: 'swap', token: TOK, amount: 5_758_125_000n, venue: 'jupiter', digest: 'd' + n, origin: 'order' as any, day: 1 });

test('the policy signer refuses a 5.76e9-raw-unit token sell against the SOL limits (the bug), and allows it once the sold token has an entry (the fix)', () => {
  const p = policy(), s = new PolicySigner(new Map([[W, 'k']]), new Map([[W, p]]));
  assert.throws(() => s.sign(sell(1)), (e: any) => e instanceof PolicyRejection && /exceeds per-tx limit/.test(e.message));
  const m: any = new SolMainnet(mkdtempSync(join(tmpdir(), 'solmain-')));
  m.openSellPolicy({ trader: { listOrders: () => [{ kind: 'limit_sell', token: TOK }] }, policy: p });
  assert.doesNotThrow(() => s.sign(sell(2)));
});

test('only sell-side orders open a token; buys and the SOL limits are untouched', () => {
  const m: any = new SolMainnet(mkdtempSync(join(tmpdir(), 'solmain-'))), p = policy();
  const kinds = ['limit_sell', 'take_profit', 'stop_loss', 'trailing_stop'];
  m.openSellPolicy({ trader: { listOrders: () => kinds.map(kind => ({ kind, token: TOK })).concat([{ kind: 'limit_buy', token: OTHER }]) }, policy: p });
  assert.ok(p.maxPerTx[TOK]! > 10n ** 20n && p.dailyLimit[TOK]! > 10n ** 20n, 'the sold token is open');
  assert.equal(p.maxPerTx[OTHER], undefined, 'a buy leaves its token unopened');
  assert.equal(p.maxPerTx[NATIVE], 10_000_000n); assert.equal(p.dailyLimit[NATIVE], 50_000_000n);
});
