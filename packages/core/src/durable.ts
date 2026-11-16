import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** Atomic durable write: write a temp file, fsync it, rename over the target, fsync the directory. A crash leaves either the old file or the new one, never a torn one. */
export function writeAtomic(path: string, data: string) {
  const tmp = `${path}.tmp-${process.pid}`; const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { const d = openSync(dirname(path), 'r'); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* directory fsync is best-effort (not supported everywhere) */ }
}
export function readIfExists(path: string): string | undefined { return existsSync(path) ? readFileSync(path, 'utf8') : undefined; }

/** Where one blob of durable state lives. Writes are SYNCHRONOUS and durable-on-return: callers checkpoint before acting (write-ahead), so a write failure must throw. */
export interface Backend { read(): string | undefined; write(data: string): void; describe(): string }
export const fileBackend = (path: string): Backend => ({ read: () => readIfExists(path), write: d => writeAtomic(path, d), describe: () => `file ${path}` });
/** A path string (file) or any Backend (e.g. Redis). */
export type Persist = string | Backend;
export const toBackend = (p: Persist): Backend => (typeof p === 'string' ? fileBackend(p) : p);
