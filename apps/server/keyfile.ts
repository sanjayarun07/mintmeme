/** The API keys file (API_KEYS_FILE): one "sha256hex:userId[:read|trade|app]" line per key, # comments. Read by the execution server and the practice API,
 *  written by apps/server/keys.ts and the key dashboard (apps/keys). Plain keys are never accepted here. */
import { readFileSync, watchFile, unwatchFile } from 'node:fs';
import type { ApiKey } from '../api/server.ts';

export function parseKeyFile(text: string, o: { allowEmpty?: boolean } = {}): ApiKey[] {
  const out: ApiKey[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const s = line.trim(); if (!s || s.startsWith('#')) return;
    const [keyHash, userId, scope = 'trade'] = s.split(':');
    if (!/^[0-9a-f]{64}$/i.test(keyHash ?? '') || !userId || (scope !== 'trade' && scope !== 'read' && scope !== 'app')) throw new Error(`API_KEYS_FILE line ${i + 1}: expected "sha256hex:userId[:read|trade|app]" (plain keys are not accepted here)`);
    out.push({ keyHash, userId, scope });
  });
  if (!out.length && !o.allowEmpty) throw new Error('API_KEYS_FILE has no keys');
  return out;
}

/** Re-reads the keys file whenever it changes (polled every `intervalMs`; the key dashboard, apps/keys, writes it) and hands the new keys to `apply`.
 *  An unreadable or malformed file keeps the keys in use and reports why; a file with every key revoked is applied (nobody gets in). Keys are never logged. */
export function watchKeyFile(path: string, apply: (keys: ApiKey[]) => void, log: (m: string) => void = m => console.log(m), intervalMs = 2000) {
  let last = '';
  try { last = readFileSync(path, 'utf8'); } catch { /* reported on the first change */ }
  const check = () => {
    let text: string; try { text = readFileSync(path, 'utf8'); } catch (e) { log(`API_KEYS_FILE reload: cannot read it (${(e as NodeJS.ErrnoException).code ?? 'error'}); keeping the keys in use`); return; }
    if (text === last) return; last = text;
    try { const keys = parseKeyFile(text, { allowEmpty: true }); apply(keys); log(`API_KEYS_FILE reloaded: ${keys.length} key(s)`); } catch (e) { log(`API_KEYS_FILE reload refused, keeping the keys in use: ${(e as Error).message}`); }
  };
  watchFile(path, { interval: intervalMs, persistent: false }, check);
  return { check, stop: () => unwatchFile(path, check) };
}

