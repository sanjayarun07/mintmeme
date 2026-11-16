import { SimChain, CpAmm, LinearCurve, Store, PolicySigner, Router, Engine, NATIVE } from '../src/index.ts';
import type { Intent, WalletPolicy } from '../src/index.ts';

export const TOK = '0xMEME', TAX = '0xTAX', HONEY = '0xHONEY';
export function world(opts: { dailyLimit?: bigint } = {}) {
  const chain = new SimChain();
  chain.addVenue(new CpAmm('uni-v2:MEME', 'uniswap-v2', TOK, NATIVE, 1_000_000n, 1_000_000n));
  chain.addVenue(new CpAmm('uni-v2:TAX', 'uniswap-v2', TAX, NATIVE, 1_000_000n, 1_000_000n));
  chain.addVenue(new CpAmm('uni-v2:HONEY', 'uniswap-v2', HONEY, NATIVE, 1_000_000n, 1_000_000n));
  chain.tokens.set(TAX, { buyTaxBps: 1000, sellTaxBps: 1000 });
  chain.tokens.set(HONEY, { honeypot: true });
  for (const w of ['w1', 'w2']) chain.credit(w, NATIVE, 1_000_000n);
  const mkPol = (userId: string): WalletPolicy => ({ userId, chains: ['sim-evm'], allowedVenues: ['uniswap-v2', 'pump-like'], maxPerTx: { [NATIVE]: 100_000n, [TOK]: 1_000_000n },
    dailyLimit: { [NATIVE]: opts.dailyLimit ?? 250_000n, [TOK]: 10_000_000n }, destinations: ['0xSAFE'], deviceSecret: 'device-secret-' + userId });
  const policies = new Map([['w1', mkPol('u1')], ['w2', mkPol('u1')], ['x1', mkPol('u2')]]);
  const signer = new PolicySigner(new Map([['w1', 'k1'], ['w2', 'k2'], ['x1', 'k3']]), policies);
  const store = new Store();
  const engine = new Engine({ store, chain, signer, router: new Router(chain), platformFeeBps: 100 });
  const intent = (o: Partial<Intent> = {}): Intent => ({ idempotencyKey: 'k-' + Math.random(), userId: 'u1', walletId: 'w1', chain: 'sim-evm', tokenIn: NATIVE, tokenOut: TOK,
    amountIn: 10_000n, minOut: 0n, slippageBps: 300, deadline: chain.time + 600, maxFeeBps: 200, venues: ['uniswap-v2'], origin: 'manual', ...o });
  return { chain, signer, store, engine, intent, policies };
}
