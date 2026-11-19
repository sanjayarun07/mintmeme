/** The keys file behind the key dashboard: the same API_KEYS_FILE the execution server (apps/server) and the practice API (apps/api) read, one
 *  "sha256hex:userId[:read|trade|app]" line per key. Only hashes are stored; a new key's secret is returned once by `create` and never written anywhere.
 *  Labels and creation times live next to it in <file>.meta.json (the servers ignore that file). Writes go to a temp file and are renamed into place, mode 0600,
 *  and run one at a time, so a server polling the file never sees half a write. Comment lines and keys made elsewhere (apps/server/keys.ts) are kept. */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export type Scope = 'read' | 'trade' | 'app';
export interface KeyRow { hash: string; userId: string; scope: Scope; label: string | null; createdAt: string | null }
interface Meta { [hash: string]: { label?: string; createdAt?: string } }

export const USER_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const LINE_RE = /^([0-9a-f]{64}):([^:\s]+)(?::(read|trade|app))?$/i;
export class KeyError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

export function keyStore(file: string, o: { now?: () => Date; random?: (n: number) => Buffer } = {}) {
  const metaFile = file + '.meta.json', now = o.now ?? (() => new Date()), random = o.random ?? randomBytes;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => T): Promise<T> => { const p = queue.then(f); queue = p.catch(() => {}); return p; };
  const read = () => existsSync(file) ? readFileSync(file, 'utf8') : '';
  const readMeta = (): Meta => { try { return JSON.parse(readFileSync(metaFile, 'utf8')); } catch { return {}; } };
  const write = (path: string, text: string) => { const tmp = `${path}.${process.pid}.${Date.now()}.tmp`; writeFileSync(tmp, text, { mode: 0o600 }); renameSync(tmp, path); };
  const rows = (text: string, meta: Meta): KeyRow[] => text.split(/\r?\n/).map(l => LINE_RE.exec(l.trim())).filter((m): m is RegExpExecArray => !!m)
    .map(m => { const hash = m[1].toLowerCase(); return { hash, userId: m[2], scope: (m[3]?.toLowerCase() ?? 'trade') as Scope, label: meta[hash]?.label ?? null, createdAt: meta[hash]?.createdAt ?? null }; });

  return {
    file,
    list: () => rows(read(), readMeta()),
    /** A new key: the secret (shown once) and its row. The servers that read the file pick it up within a couple of seconds. */
    create: (p: { userId: unknown; scope: unknown; label?: unknown }) => serial(() => {
      const userId = String(p.userId ?? '').trim(), scope = String(p.scope ?? ''), label = p.label === undefined || p.label === null ? '' : String(p.label).trim();
      if (!USER_RE.test(userId)) throw new KeyError('bad_user', 'The user id takes 1 to 64 letters, digits, dots, dashes or underscores (no colons or spaces).');
      if (scope !== 'read' && scope !== 'trade' && scope !== 'app') throw new KeyError('bad_scope', 'The scope is read, trade or app.');
      if (label.length > 60 || /[\u0000-\u001f]/.test(label)) throw new KeyError('bad_label', 'The label takes at most 60 characters on one line.');
      const secret = 'mk_' + random(32).toString('base64url'), hash = createHash('sha256').update(secret).digest('hex');
      const text = read(), meta = readMeta(), createdAt = now().toISOString();
      write(file, (text && !text.endsWith('\n') ? text + '\n' : text) + `${hash}:${userId}:${scope}\n`);
      meta[hash] = { ...(label ? { label } : {}), createdAt }; write(metaFile, JSON.stringify(meta, null, 1) + '\n');
      return { secret, key: { hash, userId, scope: scope as Scope, label: label || null, createdAt } };
    }),
    /** Removes a key by its hash (the whole 64 hex characters). Requests with it are refused once the servers re-read the file. */
    revoke: (hash: unknown) => serial(() => {
      const h = String(hash ?? '').toLowerCase(); if (!/^[0-9a-f]{64}$/.test(h)) throw new KeyError('bad_id', 'Not a key id.');
      const text = read(), lines = text.split(/\r?\n/), keep = lines.filter(l => LINE_RE.exec(l.trim())?.[1].toLowerCase() !== h);
      if (keep.length === lines.length) throw new KeyError('not_found', 'No such key (already revoked?).', 404);
      write(file, keep.join('\n').replace(/\n*$/, '\n'));
      const meta = readMeta(); if (meta[h]) { delete meta[h]; write(metaFile, JSON.stringify(meta, null, 1) + '\n'); }
      return { revoked: h };
    }),
  };
}
