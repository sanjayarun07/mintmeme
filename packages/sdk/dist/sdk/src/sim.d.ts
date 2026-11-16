/** A self-contained PRACTICE world for trying the SDK and API without any network: a simulated chain, fixture pools, two funded wallets and a policy signer.
 *  Not a real network and not real money. Production use passes its own Engine and ChainPort (for example EvmRpcChain) to `new Trader(...)`. */
import { SimChain, PolicySigner, Engine } from '../../core/src/index.ts';
import type { WalletPolicy } from '../../core/src/index.ts';
import { Trader } from './trader.ts';
export declare const PRACTICE_TOKEN = "0xMEME";
export declare function createSimTrader(o?: {
    userId?: string;
    wallets?: string[];
    funds?: bigint;
    dailyLimit?: bigint;
    platformFeeBps?: number;
    clockMs?: () => number;
    persistDir?: string;
}): {
    trader: Trader;
    chain: SimChain;
    engine: Engine;
    policies: Map<string, WalletPolicy>;
    signer: PolicySigner;
};
