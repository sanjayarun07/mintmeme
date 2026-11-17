/** Redis state backend with NO npm dependencies: a hand-written RESP client in a worker thread, called SYNCHRONOUSLY from the engine.
 *  Why sync: the engine and runners checkpoint synchronously (write-ahead, "write fails -> stop before acting"). A worker owns the socket and the
 *  main thread waits on a SharedArrayBuffer flag (Atomics.wait) until the reply arrives, so no engine code had to become async.
 *  Cost: the event loop is blocked for each write (sub-millisecond on loopback; milliseconds on a network). Not a general-purpose client.
 *  Safety:
 *   - Single-writer lock: SET NX PX with a random token; every write goes through a Lua script that checks the token and extends the TTL, so a process
 *     that lost its lock (expired, deleted, flushed) fails CLOSED on its next checkpoint instead of overwriting the new owner's state.
 *   - Durability is only as good as the server config: with `appendonly no`, a Redis crash can lose recent checkpoints and break the write-ahead guarantee.
 *     openRedisState() refuses such a server unless you pass `requireAof: false`; describe() then says "volatile".
 *   - Values are the same JSON blobs the file backend writes (no private keys are ever stored). redis:// only: no TLS client in this build. */
import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import type { RespValue } from './resp.ts';
import type { Backend } from './durable.ts';

export class SyncRedis {
  private w?: Worker; private port?: MessagePort; private flag = new Int32Array(new SharedArrayBuffer(4));
  readonly host: string; readonly portNo: number; private password?: string;
  constructor(url = 'redis://127.0.0.1:6379', private timeoutMs = 5000) {
    const u = new URL(url); if (u.protocol !== 'redis:') throw new Error('only redis:// URLs are supported (no TLS client in this build)');
    this.host = u.hostname; this.portNo = Number(u.port || 6379); this.password = u.password ? decodeURIComponent(u.password) : undefined;
  }
  private start() {
    const { port1, port2 } = new MessageChannel();
    this.w = new Worker(new URL('./redisworker.ts', import.meta.url), { workerData: { host: this.host, port: this.portNo, password: this.password, flag: this.flag, timeoutMs: this.timeoutMs, mport: port2 }, transferList: [port2] });
    this.w.unref(); this.port = port1; port1.unref?.();
  }
  /** Send one command, wait for its reply. Throws on a server error, an unreachable server, or a timeout (the connection is then rebuilt on the next call). */
  cmd(...args: (string | number)[]): any {
    if (!this.w || !this.port) this.start();
    Atomics.store(this.flag, 0, 0); this.port!.postMessage({ args });
    const r = Atomics.wait(this.flag, 0, 0, this.timeoutMs + 1000);
    if (r === 'timed-out') { this.close(); throw new Error('redis: no reply from worker (timed out)'); }
    const m = receiveMessageOnPort(this.port!)?.message as { ok: boolean; v?: RespValue; error?: string } | undefined;
    if (!m) { this.close(); throw new Error('redis: worker returned no message'); }
    if (!m.ok) throw new Error(`redis: ${m.error}`);
    return m.v;
  }
  close() { this.w?.terminate(); this.port?.close(); this.w = undefined; this.port = undefined; }
}

/** Write KEYS[2] only while KEYS[1] (the lock) still holds our token, extending the lock. Shared with the cluster server's per-user leases. */
export const WRITE_LUA = "if redis.call('get',KEYS[1])==ARGV[1] then redis.call('pexpire',KEYS[1],ARGV[2]); redis.call('set',KEYS[2],ARGV[3]); return 1 else return 0 end";
/** Extend KEYS[1] only while it still holds our token. */
export const RENEW_LUA = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end";
export const RELEASE_LUA = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";

export interface RedisStateOpts { url?: string; namespace: string; lockTtlMs?: number; requireAof?: boolean; timeoutMs?: number }
export interface RedisState {
  engine: Backend; orders: Backend; copy: Backend; client: SyncRedis;
  /** A backend for any other named piece of state (for example `trader` or `bulk-b1`), under the same single-writer lock. */
  backend(name: string): Backend;
  durability: { appendonly: string; appendfsync: string };
  /** Extend the lock without writing (call from an idle loop that checkpoints rarely). Throws if the lock was lost. */
  renew(): void; release(): void;
}
/** Connects, checks the server's durability settings, takes the single-writer lock for `namespace`, and returns backends for the engine store, the order runner and the copy runner. */
export function openRedisState(o: RedisStateOpts): RedisState {
  const r = new SyncRedis(o.url, o.timeoutMs ?? 5000), ttl = o.lockTtlMs ?? 30_000, ns = o.namespace, token = randomUUID(), lockKey = `${ns}:lock`;
  if (r.cmd('PING') !== 'PONG') throw new Error('redis: unexpected reply to PING');
  let appendonly = 'unknown', appendfsync = 'unknown';
  try { const a = r.cmd('CONFIG', 'GET', 'appendonly'), f = r.cmd('CONFIG', 'GET', 'appendfsync'); appendonly = a?.[1] ?? 'unknown'; appendfsync = f?.[1] ?? 'unknown'; } catch { /* CONFIG may be disabled on managed servers */ }
  if ((o.requireAof ?? true) && appendonly !== 'yes') { r.close(); throw new Error(`redis durability check failed: appendonly=${appendonly}. A Redis crash could lose recent checkpoints. Enable AOF (CONFIG SET appendonly yes) or pass requireAof:false to accept volatile state.`); }
  if (r.cmd('SET', lockKey, token, 'NX', 'PX', ttl) !== 'OK') { r.close(); throw new Error(`redis state "${ns}" is locked by another process (single writer only)`); }
  const volatile = appendonly !== 'yes';
  const backend = (name: string): Backend => { const key = `${ns}:${name}`; return {
    read: () => r.cmd('GET', key) ?? undefined,
    write: data => { if (r.cmd('EVAL', WRITE_LUA, 2, lockKey, key, token, ttl, data) !== 1) throw new Error(`redis state "${ns}": lock lost, refusing to write ${name} (another process may own this state)`); },
    describe: () => `redis ${r.host}:${r.portNo} ${key}${volatile ? ' (volatile: AOF off)' : ''}` }; };
  return { engine: backend('engine'), orders: backend('orders'), copy: backend('copy'), backend, client: r, durability: { appendonly, appendfsync },
    renew: () => { if (r.cmd('EVAL', RENEW_LUA, 1, lockKey, token, ttl) !== 1) throw new Error(`redis state "${ns}": lock lost`); },
    release: () => { try { r.cmd('EVAL', RELEASE_LUA, 1, lockKey, token); } finally { r.close(); } } };
}
