export type StepState = 'pending' | 'done' | 'failed';
export interface BridgeProvider {
    name: string;
    trust: string;
    send(op: string, amt: bigint): 'ok' | 'fail';
    status(op: string): 'in_transit' | 'arrived' | 'lost';
}
export interface BridgeOp {
    id: string;
    steps: {
        name: 'source_tx' | 'in_transit' | 'destination_confirm' | 'swap';
        state: StepState;
        note?: string;
    }[];
    amount: bigint;
    minReceived: bigint;
    destAddr: string;
    destAuthorized: boolean;
    intermediate: 'source' | 'bridge' | 'destination';
}
/** Persisted step machine; bridge+swap is NOT atomic, so every step is recorded and balances stay recoverable. */
export declare function startBridge(id: string, amount: bigint, minReceived: bigint, destAddr: string, authorizedDests: string[]): BridgeOp;
export declare function resume(op: BridgeOp, p: BridgeProvider, doSwap: () => boolean): BridgeOp;
/** Batch distribute with per-item state so a partial failure can be resumed without double-sending. */
export declare function distribute(items: {
    to: string;
    amount: bigint;
    done?: boolean;
}[], send: (to: string, a: bigint) => boolean, reserve: bigint, balance: bigint): {
    to: string;
    amount: bigint;
    done?: boolean;
}[];
/** Plan a /disperse: split `pctBps` (10_000 = 100%) of `balance` EQUALLY across recipients, after keeping `reserve` (gas) back.
 *  Source: https://docs.maestrobots.com/sniper/funds-management.md ("splitting a chosen percentage of a token balance equally"). Integer division: the remainder stays in the source. */
export declare function planDisperse(balance: bigint, pctBps: number, to: string[], reserve?: bigint): {
    to: string;
    amount: bigint;
    done?: boolean;
}[];
export interface CollectItem {
    from: string;
    token: string;
    done?: boolean;
    sent?: bigint;
    note?: string;
}
export interface CollectDeps {
    receiver: string; /** the user's own wallets: the receiver must be one of these unless allowExternalReceiver is set */
    wallets: string[];
    allowExternalReceiver?: boolean;
    nativeToken: string; /** native coin kept back in EACH native source for gas */
    reserveNative: bigint;
    balanceOf(wallet: string, token: string): bigint;
    send(from: string, to: string, token: string, amount: bigint): boolean;
    /** Per-item policy cap (a wallet's per-transaction limit). A sweep above the cap sends exactly the cap, marks the item done with note 'capped', and does NOT loop: the rest stays and the user can sweep again. */
    cap?(from: string, token: string): bigint | undefined;
}
/** /collect sweep: selected source wallets -> one receiver, native and tokens. https://docs.maestrobots.com/sniper/funds-management.md
 *  Resumable: each item carries `done`; call again with the same array after a failure and finished items are never sent twice. Stops at the first failed send (state stays consistent).
 *  Native: balance minus `reserveNative`. Tokens: the whole raw balance. A source equal to the receiver, or with nothing to send, is marked done with a note. */
export declare function collect(items: CollectItem[], d: CollectDeps): CollectItem[];
