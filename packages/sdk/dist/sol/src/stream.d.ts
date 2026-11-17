/** EVENT-DRIVEN TRIGGER FOR SOLANA. Instead of waiting for the once-a-second poll, subscribe to account changes (a bonding curve, a pool's vaults) over the node's WebSocket and run the trader the moment one changes.
 *  Standard Solana `accountSubscribe`, so it works with any node that offers a WebSocket (Alchemy, Helius, a local validator, devnet). It makes a trigger fire sooner after a price change; it does not make the network
 *  or the node faster, and an RPC WebSocket is not a validator-level feed (Yellowstone gRPC is faster and is not implemented here).
 *  Safety: a missed or dropped message only costs speed. Orders still evaluate on every tick, so the 1-second poll stays on as a backstop (see `ChangeTrigger`). */
export interface WsLike {
    readyState: number;
    send(data: string): void;
    close(): void;
    onopen: ((ev?: unknown) => void) | null;
    onmessage: ((ev: {
        data: unknown;
    }) => void) | null;
    onclose: ((ev?: unknown) => void) | null;
    onerror: ((ev?: unknown) => void) | null;
}
export interface StreamOptions {
    wsUrl: string;
    commitment?: 'processed' | 'confirmed' | 'finalized';
    makeSocket?: (url: string) => WsLike;
    minBackoffMs?: number;
    maxBackoffMs?: number;
    staleAfterMs?: number;
    now?: () => number;
    setTimer?: typeof setTimeout;
    log?: (m: string) => void;
}
export type AccountHandler = (account: string, slot: number, receivedAt: number) => void;
export declare class SolanaStream {
    private o;
    private ws?;
    private subs;
    private reqToAcct;
    private subToAcct;
    private next;
    private backoff;
    private stopped;
    private timer?;
    private watchdog?;
    connected: boolean;
    reconnects: number;
    lastMessageAt: number;
    events: number;
    constructor(o: StreamOptions);
    private now;
    private mk;
    /** Watch one account. Returns a function that stops watching it. Subscribing before `start()` is fine. */
    watch(account: string, h: AccountHandler): () => void;
    private sendSub;
    start(): void;
    stop(): void;
    private open;
    private retry;
}
/** Run `fire` after a watched account changes, never more than once per `minIntervalMs`, never two at once, and with one trailing run if more changes arrive meanwhile (so the last change is never lost). */
export declare class ChangeTrigger {
    private fire;
    private o;
    private running;
    private again;
    private last;
    private timer?;
    fired: number;
    errors: number;
    lastLatencyMs?: number;
    private eventAt;
    constructor(fire: () => Promise<void>, o?: {
        minIntervalMs?: number;
        now?: () => number;
        onError?: (e: Error) => void;
    });
    private now;
    /** Pass this to `SolanaStream.watch`. */
    onChange: (_account: string, _slot: number, receivedAt?: number) => void;
    private run;
}
