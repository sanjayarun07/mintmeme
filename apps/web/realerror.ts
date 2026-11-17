/** Errors from the real-funds (/api/sol/*) routes, shown to the user as a toast or notice.
 *  A 4xx is a refusal made before anything was signed, so it says so, in plain words and in SOL rather than lamports.
 *  A 5xx may have failed part-way, so it points at the transaction history instead of promising that nothing happened. */
export function realError(status: number, msg: string) {
  let why = String(msg || 'Unknown error').replace(/(\d+) lamports/g, (_, n) => `${Number(n) / 1e9} SOL`).replace(/^signer policy: /, 'Safety limit: ');
  why = why.charAt(0).toUpperCase() + why.slice(1); if (!/[.!?]$/.test(why)) why += '.';
  if (status === 401) return { ok: false as const, title: 'Signed out', why, fix: 'Sign in again with your wallet or the trading key. Nothing was signed or sent.' };
  if (status < 500) return { ok: false as const, title: 'Not done', why, fix: 'Nothing was signed or sent.' };
  return { ok: false as const, title: 'Terminal error', why, fix: 'Check Transaction history before trying again: if a transaction link appears there, it was sent.' };
}
