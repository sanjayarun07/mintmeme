/** Per-user ownership for the cluster server. Each user's state (engine journal, orders, TWAPs, trader meta) lives in Redis under `<ns>:u:<user>:*`, guarded by ONE lock key.
 *  Whoever holds the lock owns the user: only that node runs the user's Trader and writes its state. The lock value is "<node url> <random token>", so any node can see who
 *  the owner is and forward requests there. Every state write goes through a Lua script that checks the token (core/redis.ts WRITE_LUA), so a node that lost its lease
 *  (expired during a pause, network split) fails CLOSED on its next write instead of overwriting the new owner. All leases on a node share one Redis connection, and the
 *  sweep and the renewal each cost one Redis call for all users (MGET, one script), not one per user. */
import { randomUUID } from 'node:crypto';
import { SyncRedis, WRITE_LUA, RELEASE_LUA, RENEW_LUA } from '../../packages/core/src/index.ts';
import type { Backend } from '../../packages/core/src/index.ts';

/** Renew many leases in one call: KEYS are lock keys, ARGV[1] the TTL, ARGV[2..] the tokens. Returns 1 or 0 per lease. */
const RENEW_ALL_LUA = "local out={} for i,k in ipairs(KEYS) do if redis.call('get',k)==ARGV[i+1] then redis.call('pexpire',k,ARGV[1]) out[i]=1 else out[i]=0 end end return out";
export const lockKey = (ns: string, user: string) => `${ns}:u:${user}:lock`;
export const usersKey = (ns: string) => `${ns}:users`;
const ownerFrom = (v: unknown) => (typeof v === 'string' ? v.split(' ')[0] : undefined);

/** The node URL that currently owns `user`, or undefined when nobody does (never owned, released, or its lease expired). */
export const ownerOf = (r: SyncRedis, ns: string, user: string): string | undefined => ownerFrom(r.cmd('GET', lockKey(ns, user)));
/** Owners of many users in one call (undefined = nobody). */
export function ownersOf(r: SyncRedis, ns: string, users: string[]): (string | undefined)[] {
  if (!users.length) return []; const v = r.cmd('MGET', ...users.map(u => lockKey(ns, u))) as unknown[]; return users.map((_, i) => ownerFrom(v?.[i]));
}

export class UserLease {
  readonly token: string; private held = false;
  constructor(private r: SyncRedis, private ns: string, readonly user: string, readonly nodeUrl: string, readonly ttlMs: number) { this.token = `${nodeUrl} ${randomUUID()}`; }
  get key() { return lockKey(this.ns, this.user); }
  get isHeld() { return this.held; }
  /** Take the lease if nobody holds it. */
  acquire(): boolean { this.held = this.r.cmd('SET', this.key, this.token, 'NX', 'PX', this.ttlMs) === 'OK'; return this.held; }
  /** Extend it. False means it was lost (expired and maybe taken by another node): the caller must stop the user's Trader at once. */
  renew(): boolean { if (!this.held) return false; this.held = this.r.cmd('EVAL', RENEW_LUA, 1, this.key, this.token, this.ttlMs) === 1; return this.held; }
  /** Give it up now, so another node can take the user at once instead of waiting for the TTL. Harmless if another node already holds it (the token is checked). */
  release() { try { this.r.cmd('EVAL', RELEASE_LUA, 1, this.key, this.token); } catch { /* the TTL expires it anyway */ } this.held = false; }
  /** A durable backend for one named piece of this user's state. Writes are refused unless this node still holds the lease. */
  backend(name: string): Backend {
    const key = `${this.ns}:u:${this.user}:${name}`;
    return {
      read: () => this.r.cmd('GET', key) ?? undefined,
      write: data => { if (this.r.cmd('EVAL', WRITE_LUA, 2, this.key, key, this.token, this.ttlMs, data) !== 1) { this.held = false; throw new Error(`lease for ${this.user} lost: refusing to write ${name} (another node may own this user now)`); } },
      describe: () => `redis ${this.r.host}:${this.r.portNo} ${key} (lease ${this.user})`,
    };
  }
  /** Renew many leases (same TTL) in one Redis call; returns which are still held. */
  static renewAll(r: SyncRedis, leases: UserLease[]): boolean[] {
    if (!leases.length) return [];
    const res = r.cmd('EVAL', RENEW_ALL_LUA, leases.length, ...leases.map(l => l.key), leases[0].ttlMs, ...leases.map(l => l.token)) as number[];
    return leases.map((l, i) => (l.held = l.held && res?.[i] === 1));
  }
}
