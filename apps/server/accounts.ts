/** Account factories: how a node builds one user's Trader over the durable state its lease gives it.
 *  `practice`: a simulated chain with fake funds (the same world as createSimTrader). Orders, the trade journal and TWAP/bulk state are durable in Redis and move between
 *  nodes on failover; the SIMULATED balances are not (a practice world is rebuilt with fresh fake funds on the node that takes the user over).
 *  Real chains: write a factory that returns `{ trader: new Trader({ engine, chain, ... , state }) }` over EvmRpcChain or SolanaChain with your own signer. The server does not
 *  ship one, because it has no production key custody (see docs/PRODUCTION_SERVER.md). */
import { createSimTrader } from '../../packages/sdk/src/sim.ts';
import type { Backend } from '../../packages/core/src/index.ts';
import type { Account } from './node.ts';

export function practiceAccount(userId: string, state: (name: string) => Backend): Account {
  const s = createSimTrader({ userId, state, clockMs: Date.now });
  // The trade journal (with each wallet's next nonce) came back from Redis but this simulated chain is new and starts at nonce 0. The engine signs with the higher
  // of the two, and the chain mines a wallet's transactions strictly in nonce order, so without this every new trade after a failover would wait forever.
  for (const [wk, n] of s.engine.d.store.nonces) { const [chain, wallet] = wk.split(':'); if (chain === s.chain.id && wallet) s.chain.nextNonceMap.set(wallet, n); }
  const clock = setInterval(() => { s.chain.time += 1; }, 1000); clock.unref?.();   // the practice chain only moves time when told to
  return { trader: s.trader, stop: () => clearInterval(clock) };
}
