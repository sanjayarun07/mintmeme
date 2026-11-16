import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
/** Atomic durable write: write a temp file, fsync it, rename over the target, fsync the directory. A crash leaves either the old file or the new one, never a torn one. */
export function writeAtomic(path, data) {
    const tmp = `${path}.tmp-${process.pid}`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
        writeSync(fd, data);
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    renameSync(tmp, path);
    try {
        const d = openSync(dirname(path), 'r');
        try {
            fsyncSync(d);
        }
        finally {
            closeSync(d);
        }
    }
    catch { /* directory fsync is best-effort (not supported everywhere) */ }
}
export function readIfExists(path) { return existsSync(path) ? readFileSync(path, 'utf8') : undefined; }
export const fileBackend = (path) => ({ read: () => readIfExists(path), write: d => writeAtomic(path, d), describe: () => `file ${path}` });
export const toBackend = (p) => (typeof p === 'string' ? fileBackend(p) : p);
