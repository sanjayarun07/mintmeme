import type { Backend } from './durable.ts';
export declare class SyncRedis {
    private timeoutMs;
    private w?;
    private port?;
    private flag;
    readonly host: string;
    readonly portNo: number;
    private password?;
    constructor(url?: string, timeoutMs?: number);
    private start;
    /** Send one command, wait for its reply. Throws on a server error, an unreachable server, or a timeout (the connection is then rebuilt on the next call). */
    cmd(...args: (string | number)[]): any;
    close(): void;
}
export interface RedisStateOpts {
    url?: string;
    namespace: string;
    lockTtlMs?: number;
    requireAof?: boolean;
    timeoutMs?: number;
}
export interface RedisState {
    engine: Backend;
    orders: Backend;
    copy: Backend;
    client: SyncRedis;
    /** A backend for any other named piece of state (for example `trader` or `bulk-b1`), under the same single-writer lock. */
    backend(name: string): Backend;
    durability: {
        appendonly: string;
        appendfsync: string;
    };
    /** Extend the lock without writing (call from an idle loop that checkpoints rarely). Throws if the lock was lost. */
    renew(): void;
    release(): void;
}
/** Connects, checks the server's durability settings, takes the single-writer lock for `namespace`, and returns backends for the engine store, the order runner and the copy runner. */
export declare function openRedisState(o: RedisStateOpts): RedisState;
