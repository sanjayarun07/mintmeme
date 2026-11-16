import type { LaunchEvent } from '../../core/src/index.ts';
import type { SolRpc } from './raydium.ts';
export interface RaydiumLaunchCfg {
    chain: string;
    program: string;
    wsol: string;
    quoteMints: string[];
    watch?: string;
    pageLimit?: number;
}
export interface SolLaunchState {
    cursor?: string;
    seeded: boolean;
    pairs: [string, {
        pair: string;
        program: string;
    }][];
    reorgWatch: {
        txHash: string;
        slot: number;
    }[];
}
export declare class RaydiumLaunchSource {
    private cfg;
    private rpc;
    cursor?: string;
    private seeded;
    pairs: Map<string, {
        pair: string;
        program: string;
    }>;
    /** number of signatures the last poll could not reach (page full before the cursor): 0 = no gap */
    missed: number;
    ignored: string[];
    private watchTx;
    constructor(cfg: RaydiumLaunchCfg, rpc: SolRpc);
    snapshot(): SolLaunchState;
    load(s: SolLaunchState): void;
    poll(): Promise<{
        events: LaunchEvent[];
        reorged: {
            chain: string;
            txHash: string;
        }[];
    }>;
    parse(sig: string): Promise<LaunchEvent[]>;
}
