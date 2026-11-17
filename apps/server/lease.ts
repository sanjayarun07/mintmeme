/** Per-user ownership for the cluster server. Each user's state (engine journal, orders, TWAPs, trader meta) lives in Redis under `<ns>:u:<user>:*`, guarded by ONE lock key.
 *  Whoever holds the lock owns the user: only that node runs the user's Trader and writes its state. The lock value is "<node url> <random token>", so any node can see who
 *  the owner is and forward requests there. Every state write goes through a Lua script that checks the token (core/redis.ts WRITE_LUA), so a node that lost its lease
 *  (expired during a pause, network split) fails CLOSED on its next write instead of overwriting the new owner. All leases on a node share one Redis connection. */
import { randomUUID } from 'node:crypto';
import { SyncRedis, WRITE_LUA, RELEASE_LUA } from '../../packages/core/src/index.ts';
import type { Backend } from '../../packages/core/src/index.ts';

const RENEW_LUA = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end";
export const lockKey = (ns: string, user: string) => `${ns}:u:${user}:lock`;
export const usersKey = (ns: string) => `${ns}:users`;

/** The node URL that currently owns `user`, or undefined when nobody does (never owned, released, or its lease expired). */
export function ownerOf(r: SyncRedis, ns: string, user: string): string | undefined {
  const v = r.cmd('GET', lockKey(ns, user)); return typeof v === 'string' ? v.split(' ')[0] : undefined;
}

export class UserLease {
  readonly token: string; private held = false;
  constructor(private r: SyncRedis, private ns: string, readonly user: string, readonly nodeUrl: string, private ttlMs: number) { this.token = `${nodeUrl} ${randomUUID()}`; }
  get key() { return lockKey(this.ns, this.user); }
  /** Take the lease if nobody holds it. */
  acquire(): boolean { this.held = this.r.cmd('SET', this.key, this.token, 'NX', 'PX', this.ttlMs) === 'OK'; return this.held; }
  /** Extend it. False means it was lost (expired and maybe taken by another node): the caller must stop the user's Trader at once. */
  renew(): boolean { if (!this.held) return false; this.held = this.r.cmd('EVAL', RENEW_LUA, 1, this.key, this.token, this.ttlMs) === 1; return this.held; }
  /** Give it up now (graceful shutdown), so another node can take the user immediately instead of waiting for the TTL. */
  release() { if (this.held) { try { this.r.cmd('EVAL', RELEASE_LUA, 1, this.key, this.token); } catch { /* the TTL expires it anyway */ } } this.held = false; }
  /** A durable backend for one named piece of this user's state. Writes are refused unless this node still holds the lease. */
  backend(name: string): Backend {
    const key = `${this.ns}:u:${this.user}:${name}`;
    return {
      read: () => this.r.cmd('GET', key) ?? undefined,
      write: data => { if (this.r.cmd('EVAL', WRITE_LUA, 2, this.key, key, this.token, this.ttlMs, data) !== 1) { this.held = false; throw new Error(`lease for ${this.user} lost: refusing to write ${name} (another node may own this user now)`); } },
      describe: () => `redis ${this.r.host}:${this.r.portNo} ${key} (lease ${this.user})`,
    };
  }
}
