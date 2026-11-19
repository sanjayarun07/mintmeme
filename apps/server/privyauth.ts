/** Sign in with Privy instead of pasting an API key (the /app trading app). The browser sends the Privy access token it already has; the server checks it and opens a session.
 *  Checks, all required: an ES256 signature by one of Privy's published keys for THIS app (JWKS, or PRIVY_VERIFICATION_KEY), issuer "privy.io", audience = PRIVY_APP_ID,
 *  not expired (small clock leeway), a Privy user id (did:privy:...) as subject. A valid Privy login alone grants nothing: the user id must be mapped to an account by the
 *  operator (PRIVY_USERS="did:privy:abc=arun,did:privy:def=bob"), so anyone else who logs in to the same Privy app is refused. API keys keep working for bots, scripts and MCP.
 *  Sessions: 32 random bytes, stored in Redis only as their SHA-256 hash with the user id and an expiry (PRIVY_SESSION_HOURS, default 12); the API resolves them like a trade key. */
import { createHash, createPublicKey, randomBytes, verify as verifySig, type KeyObject } from 'node:crypto';

export class AuthError extends Error { constructor(msg: string, public code: string, public status = 401, public fix?: string) { super(msg); } }
const b64u = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Privy user id -> account, from "did:privy:a=arun,did:privy:b=bob". Account ids follow the keys file's rule (letters, digits, dot, dash, underscore). */
export function parsePrivyUsers(s: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of (s ?? '').split(',').map(x => x.trim()).filter(Boolean)) {
    const i = part.lastIndexOf('='), did = part.slice(0, i).trim(), user = part.slice(i + 1).trim();
    if (i < 1 || !/^did:privy:[A-Za-z0-9]{10,64}$/.test(did) || !/^[A-Za-z0-9._-]{1,64}$/.test(user)) throw new Error(`PRIVY_USERS: "${part}" must be did:privy:<id>=<account>`);
    m.set(did, user);
  }
  return m;
}

/** Privy's signing keys for this app, cached for an hour (a token with an unknown kid refreshes once). PRIVY_VERIFICATION_KEY (the PEM from the dashboard) replaces the fetch. */
export function privyKeys(appId: string, o: { pem?: string; fetch?: typeof fetch; now?: () => number } = {}) {
  let cache: { at: number; keys: Map<string, KeyObject> } | undefined;
  const now = o.now ?? Date.now;
  return async (kid?: string, refresh = false): Promise<KeyObject[]> => {
    if (o.pem) return [createPublicKey(o.pem)];
    if (!cache || refresh || now() - cache.at > 3_600_000) {
      const r = await (o.fetch ?? fetch)(`https://auth.privy.io/api/v1/apps/${encodeURIComponent(appId)}/jwks.json`, { signal: AbortSignal.timeout(8_000) });
      if (!r.ok) throw new AuthError('Privy\'s signing keys could not be loaded.', 'privy_unavailable', 503, 'Retry shortly.');
      const j: any = await r.json(), keys = new Map<string, KeyObject>();
      for (const k of j?.keys ?? []) if (k?.kty === 'EC' && k?.crv === 'P-256') keys.set(String(k.kid ?? ''), createPublicKey({ key: k, format: 'jwk' }));
      cache = { at: now(), keys };
    }
    const hit = kid ? cache.keys.get(kid) : undefined;
    return hit ? [hit] : kid && !refresh ? [] : [...cache.keys.values()];
  };
}

/** Check a Privy access token. Returns the Privy user id, or throws AuthError saying what is wrong (never the token). */
export async function verifyPrivyToken(token: unknown, o: { appId: string; keys: (kid?: string, refresh?: boolean) => Promise<KeyObject[]>; now?: () => number }): Promise<{ did: string; exp: number }> {
  if (typeof token !== 'string' || token.length > 4096) throw new AuthError('Send the Privy access token.', 'bad_token');
  const parts = token.split('.'); if (parts.length !== 3) throw new AuthError('That is not a Privy login token.', 'bad_token');
  let head: any, claims: any; try { head = JSON.parse(b64u(parts[0]).toString()); claims = JSON.parse(b64u(parts[1]).toString()); } catch { throw new AuthError('That is not a Privy login token.', 'bad_token'); }
  if (head?.alg !== 'ES256') throw new AuthError('The login token is not signed the way Privy signs.', 'bad_token');
  const data = Buffer.from(parts[0] + '.' + parts[1]), sig = b64u(parts[2]);
  let keys = await o.keys(head.kid); if (!keys.length) keys = await o.keys(head.kid, true);
  if (!keys.some(k => { try { return verifySig('sha256', data, { key: k, dsaEncoding: 'ieee-p1363' }, sig); } catch { return false; } })) throw new AuthError('The login token\'s signature is not Privy\'s.', 'bad_signature');
  const now = Math.floor((o.now ?? Date.now)() / 1000), aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== 'privy.io') throw new AuthError('The login token was not issued by Privy.', 'bad_token');
  if (!aud.includes(o.appId)) throw new AuthError('The login token is for another Privy app.', 'wrong_app');
  if (typeof claims.exp !== 'number' || claims.exp < now - 30) throw new AuthError('Your Privy login has expired.', 'expired', 401, 'Log in with Privy again.');
  if (typeof claims.nbf === 'number' && claims.nbf > now + 30) throw new AuthError('The login token is not valid yet.', 'bad_token');
  if (typeof claims.sub !== 'string' || !/^did:privy:[A-Za-z0-9]{10,64}$/.test(claims.sub)) throw new AuthError('The login token names no Privy user.', 'bad_token');
  return { did: claims.sub, exp: claims.exp };
}

export const sessionKey = (ns: string, hashHex: string) => `${ns}:session:${hashHex}`;
type Redis = { cmd: (...a: (string | number)[]) => unknown };
/** Open a session for `userId`: returns the token once; Redis keeps only its hash. */
export function openSession(r: Redis, ns: string, userId: string, did: string, ttlS: number) {
  const token = 'mts_' + randomBytes(32).toString('base64url'), h = createHash('sha256').update(token).digest('hex');
  r.cmd('SET', sessionKey(ns, h), JSON.stringify({ userId, did, at: Date.now() }), 'EX', ttlS);
  return { session: token, userId, expiresAt: new Date(Date.now() + ttlS * 1000).toISOString() };
}
/** The account a session hash belongs to, or undefined (unknown, expired, or Redis unreachable: refusing is the safe side). Sessions only act for plain user accounts. */
export function lookupSession(r: Redis, ns: string, hash: Buffer): { userId: string; scope: 'trade' } | undefined {
  try { const s = r.cmd('GET', sessionKey(ns, hash.toString('hex'))); if (typeof s !== 'string') return undefined; const v = JSON.parse(s); return typeof v?.userId === 'string' && !v.userId.includes(':') ? { userId: v.userId, scope: 'trade' } : undefined; }
  catch { return undefined; }
}
export function closeSession(r: Redis, ns: string, token: string) { r.cmd('DEL', sessionKey(ns, createHash('sha256').update(token).digest('hex'))); }
