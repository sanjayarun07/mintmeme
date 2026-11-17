/** A self-contained PRACTICE world for trying the SDK and API without any network: a simulated chain, fixture pools, two funded wallets and a policy signer.
 *  Not a real network and not real money. Production use passes its own Engine and ChainPort (for example EvmRpcChain) to `new Trader(...)`. */
import { SimChain, CpAmm, Store, PolicySigner, Router, Engine, NATIVE } from '../../core/src/index.ts';
import type { WalletPolicy, Backend } from '../../core/src/index.ts';
import { Trader } from './trader.ts';
import type { UsdFeed } from './trader.ts';

export const PRACTICE_TOKEN = '0xMEME';
export function createSimTrader(o: { userId?: string; wallets?: string[]; funds?: bigint; dailyLimit?: bigint; platformFeeBps?: number; clockMs?: () => number; persistDir?: string; usd?: UsdFeed; state?: (name: string) => Backend } = {}) {
  const userId = o.userId ?? 'u1', wallets = o.wallets ?? ['w1', 'w2'];
  const chain = new SimChain(); chain.addVenue(new CpAmm('uni-v2:MEME', 'uniswap-v2', PRACTICE_TOKEN, NATIVE, 1_000_000n, 1_000_000n));
  for (const w of wallets) chain.credit(w, NATIVE, o.funds ?? 1_000_000n);
  const pol = (): WalletPolicy => ({ userId, chains: ['sim-evm'], allowedVenues: ['uniswap-v2'], maxPerTx: { [NATIVE]: 100_000n, [PRACTICE_TOKEN]: 1_000_000n }, dailyLimit: { [NATIVE]: o.dailyLimit ?? 5_000_000n, [PRACTICE_TOKEN]: 10_000_000n }, destinations: [], deviceSecret: 'practice-device-' + userId });
  const policies = new Map(wallets.map(w => [w, pol()])), signer = new PolicySigner(new Map(wallets.map(w => [w, 'k-' + w])), policies);
  const engine = new Engine({ store: o.state ? Store.open(o.state('engine')) : new Store(), chain, signer, router: new Router(chain), platformFeeBps: o.platformFeeBps ?? 100 });
  // a USD feed reports wall-clock times, so with one the default clock is the wall clock too (the counter would make every feed reading look like the future)
  let ms = 0; const clockMs = o.clockMs ?? (o.usd ? Date.now : () => (ms += 1));
  // The practice chain has no clock: blocks are mined on demand so trades confirm, but TIME only moves when YOU move it (chain.time += seconds), which keeps TWAP and order expiry deterministic.
  const advanceChain = () => { const t = chain.time; chain.mine(4); chain.time = t; };
  const trader = new Trader({ engine, chain, userId, venues: ['uniswap-v2'], clockMs, persistDir: o.persistDir, state: o.state, advanceChain, usd: o.usd });
  return { trader, chain, engine, policies, signer };
}
