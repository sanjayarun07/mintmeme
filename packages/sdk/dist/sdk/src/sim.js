/** A self-contained PRACTICE world for trying the SDK and API without any network: a simulated chain, fixture pools, two funded wallets and a policy signer.
 *  Not a real network and not real money. Production use passes its own Engine and ChainPort (for example EvmRpcChain) to `new Trader(...)`. */
import { SimChain, CpAmm, Store, PolicySigner, Router, Engine, NATIVE } from '../../core/src/index.js';
import { Trader } from './trader.js';
export const PRACTICE_TOKEN = '0xMEME';
export function createSimTrader(o = {}) {
    const userId = o.userId ?? 'u1', wallets = o.wallets ?? ['w1', 'w2'];
    const chain = new SimChain();
    chain.addVenue(new CpAmm('uni-v2:MEME', 'uniswap-v2', PRACTICE_TOKEN, NATIVE, 1000000n, 1000000n));
    for (const w of wallets)
        chain.credit(w, NATIVE, o.funds ?? 1000000n);
    const pol = () => ({ userId, chains: ['sim-evm'], allowedVenues: ['uniswap-v2'], maxPerTx: { [NATIVE]: 100000n, [PRACTICE_TOKEN]: 1000000n }, dailyLimit: { [NATIVE]: o.dailyLimit ?? 5000000n, [PRACTICE_TOKEN]: 10000000n }, destinations: [], deviceSecret: 'practice-device-' + userId });
    const policies = new Map(wallets.map(w => [w, pol()])), signer = new PolicySigner(new Map(wallets.map(w => [w, 'k-' + w])), policies);
    const engine = new Engine({ store: new Store(), chain, signer, router: new Router(chain), platformFeeBps: o.platformFeeBps ?? 100 });
    let ms = 0;
    const clockMs = o.clockMs ?? (() => (ms += 1));
    // The practice chain has no clock: blocks are mined on demand so trades confirm, but TIME only moves when YOU move it (chain.time += seconds), which keeps TWAP and order expiry deterministic.
    const advanceChain = () => { const t = chain.time; chain.mine(4); chain.time = t; };
    const trader = new Trader({ engine, chain, userId, venues: ['uniswap-v2'], clockMs, persistDir: o.persistDir, advanceChain });
    return { trader, chain, engine, policies, signer };
}
