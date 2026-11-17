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
/** Write KEYS[2] only while KEYS[1] (the lock) still holds our token, extending the lock. Shared with the cluster server's per-user leases. */
export declare const WRITE_LUA = "if redis.call('get',KEYS[1])==ARGV[1] then redis.call('pexpire',KEYS[1],ARGV[2]); redis.call('set',KEYS[2],ARGV[3]); return 1 else return 0 end";
export declare const RELEASE_LUA = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";
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
