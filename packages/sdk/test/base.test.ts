import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrivyApi } from '../../sol/src/index.ts';
import { PrivyEvmSigner, BASE, simpleBody } from '../src/index.ts';
import { fakePrivyEvm, BASE_ROUTER } from '../../evm/test/fakeprivyevm.ts';
import { signerOf, encodeCall } from '../../evm/src/index.ts';

const swap = (wallet: string, value = 10n ** 15n) => ({ wallet, to: BASE_ROUTER, data: encodeCall('swapExactETHForTokens(uint256,address[],address,uint256)', [1n, [BASE.weth, '0x9a26f5433671751c3276a065f57e5a02d2817973'], wallet, 2_000_000_000n]), value, nonce: 4, chainId: 8453, gasLimit: 200_000n, maxFeePerGas: 10_000_000n, maxPriorityFeePerGas: 1_000_000n });

test('Privy (Ethereum): the delegation check, and signing a Base swap through eth_signTransaction', async () => {
  const p = fakePrivyEvm(), api = new PrivyApi({ ...p.cfg, fetchFn: p.fetchFn });
  assert.equal(api.signMethod, 'eth_signTransaction');
  assert.deepEqual(await api.delegation(p.address), { ok: true, walletId: 'evm-wallet-1' }, 'found although Privy returns the address in another case');
  const signer = new PrivyEvmSigner(api, new Map([[p.address, 'evm-wallet-1']]));
  const raw = await signer.sign(swap(p.address)); assert.equal(signerOf(raw), p.address); assert.equal(p.state.signed, 1);
  // an approve of the router is allowed; a transfer to someone else is refused by the policy, and nothing is signed
  await signer.sign({ ...swap(p.address, 0n), to: '0x9a26f5433671751c3276a065f57e5a02d2817973', data: encodeCall('approve(address,uint256)', [BASE_ROUTER, 5n]) });
  await assert.rejects(signer.sign({ ...swap(p.address, 0n), to: '0x9a26f5433671751c3276a065f57e5a02d2817973', data: encodeCall('transfer(address,uint256)', ['0x000000000000000000000000000000000000dead', 5n]) }), /Policy violation.*nothing was sent/);
  await assert.rejects(signer.sign(swap(p.address, 10n ** 17n)), /value above the cap/);
  await assert.rejects(signer.sign(swap('0x000000000000000000000000000000000000beef')), /no Privy wallet is set up/);
});

test('a signed transaction that differs from the request, or comes from another key, is refused', async () => {
  const p = fakePrivyEvm(), api = new PrivyApi({ ...p.cfg, fetchFn: p.fetchFn }), signer = new PrivyEvmSigner(api, new Map([[p.address, 'evm-wallet-1']]));
  p.state.mode = 'tamper'; await assert.rejects(signer.sign(swap(p.address)), /different transaction \(value .*nothing was sent/);
  p.state.mode = 'wrong-key'; await assert.rejects(signer.sign(swap(p.address)), /different key than this wallet/);
});

test('delegation explains what is missing: no signer, another policy, a policy without eth_signTransaction', async () => {
  const p = fakePrivyEvm(), api = new PrivyApi({ ...p.cfg, fetchFn: p.fetchFn });
  p.state.delegated = false; assert.match((await api.delegation(p.address) as any).why, /not allowed automatic trading/);
  p.state.delegated = 'other-policy'; assert.match((await api.delegation(p.address) as any).why, /not limited by this app's trading policy/);
  p.state.delegated = true; p.state.policyMethod = 'eth_sendTransaction'; assert.match((await api.delegation(p.address) as any).why, /ALLOW rule for the method eth_signTransaction.*Base policy rules/);
  assert.match((await api.delegation('0x000000000000000000000000000000000000beef') as any).why, /not a Privy wallet of this app/);
  assert.throws(() => new PrivyEvmSigner(new PrivyApi({ ...p.cfg, chainType: 'solana' }), new Map()), /chainType ethereum/);
});

test('plain units on Base: eth amounts and prices in ETH per token', async () => {
  const o = { address: '0xaa', decimals: async () => 18, balance: async () => 1000n, native: { key: 'eth', decimals: 18 } };
  assert.deepEqual(await simpleBody('/v1/trades/buy', { token: '0xt', eth: '0.001', slippagePct: 1 }, o), { token: '0xt', walletId: '0xaa', amount: '1000000000000000', slippageBps: 100 });
  assert.equal((await simpleBody('/v1/orders/limit-buy', { token: '0xt', eth: '0.001', price: '0.000002' }, o)).priceE18, '2000000000000');   // 2e-6 ETH per token (18 decimals) = 2e-6 wei per raw unit, x1e18
  assert.equal((await simpleBody('/v1/trades/buy', { token: '0xt', sol: '1' }, o)).amount, undefined, 'sol means nothing on Base');
});
