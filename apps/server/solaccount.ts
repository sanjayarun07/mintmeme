/** REAL SOLANA ACCOUNTS for the execution server (MODE=solana-mainnet). Each API user links their own Privy wallet; the node that owns the user runs
 *  `createSolanaTrader` (packages/sdk/src/solana.ts) over the user's Redis state, so trades are signed by Privy within the policy the user agreed to and the SOL caps.
 *  No private key is ever held by a node.
 *
 *  Linking (routes added to the API, see linkRoutes):
 *   1. POST /v1/wallet/link/start {address}  -> a one-time message
 *   2. the user's Privy wallet signs it; POST /v1/wallet/link/finish {address, signature}: proves this API user controls the wallet, then the node asks Privy whether the wallet
 *      carries this server's signer with the policy. Only then is {address, walletId} saved under the user in Redis (through the user's lease, fail-closed).
 *   GET /v1/wallet shows the link; DELETE /v1/wallet removes it. Removing the signer in Privy also stops signing at once (Privy refuses; nothing is sent).
 *  Every claim of the user by a node asks Privy again before anything is signed, so a revoked wallet is never traded after a failover or restart. */
import { randomBytes } from 'node:crypto';
import type { Backend } from '../../packages/core/src/index.ts';
import { PrivyApi, verifySignature, looksLikeMint } from '../../packages/sol/src/index.ts';
import type { PrivyConfig } from '../../packages/sol/src/index.ts';
import { createSolanaTrader, jupiterSolUsd } from '../../packages/sdk/src/solana.ts';
import { SdkError } from '../../packages/sdk/src/wire.ts';
import type { Account } from './node.ts';
import type { Route } from '../api/server.ts';

export interface SolLink { address: string; walletId: string; linkedAt: number }
export const readLink = (b: Backend): SolLink | undefined => { try { const j = JSON.parse(b.read() ?? ''); return j && looksLikeMint(j.address) && typeof j.walletId === 'string' ? j : undefined; } catch { return undefined; } };
type Status = { address?: string; active: boolean; why?: string };
/** Routes that spend or sell from the wallet (refused while the wallet is not active). */
const TRADE_PATHS = /^\/v1\/(trades\/(buy|sell)$|orders\/[a-z-]+$|twap$|bulk\/(buy|sell)$)/;

/** The account factory. A user with no linked (or no longer delegated) wallet still gets an account: reads work, every call that names a wallet is refused with the reason. */
export function solanaAccounts(c: { rpcUrl: string; privy: PrivyConfig; venues?: string[]; caps?: { maxTradeLamports: bigint; dailyCapLamports: bigint }; solUsd?: () => Promise<{ price: number; at: number } | null>; log?: (m: string) => void }) {
  const privy = new PrivyApi(c.privy), solUsd = c.solUsd ?? jupiterSolUsd(), status = new Map<string, Status>();
  const make = async (userId: string, state: (name: string) => Backend): Promise<Account> => {
    const link = readLink(state('solwallet'));
    const s = await createSolanaTrader({ userId, address: link?.address, walletId: link?.walletId, rpcUrl: c.rpcUrl, privy, state, caps: c.caps, venues: c.venues, solUsd, log: c.log });
    status.set(userId, { address: link?.address, active: s.active, why: s.active ? undefined : (link ? s.why : 'No wallet is linked. Link your Privy wallet: POST /v1/wallet/link/start, then /v1/wallet/link/finish.') });
    return { trader: s.trader, prepare: async (raw: any, path: string) => {
      const trades = TRADE_PATHS.test(path); if (trades) s.refuseIfInactive();
      const tok = raw?.token ?? raw?.mint; if (typeof tok === 'string') await s.prepare(tok);   // learn the token first: plain units need its decimals
      const body = await s.simple(path, raw);
      if (trades || typeof tok === 'string') await s.sync();   // the chain's clock (deadlines) and pool state (quotes) as of now, not as of the last tick
      return body;
    } };
  };
  return { make, status: (u: string) => status.get(u), privy };
}

/** The wallet-linking routes. `state(user)` gives the owner node's durable state for that user (writes go through the user's lease); `reload(user)` rebuilds its account. */
export function linkRoutes(o: { privy: PrivyApi; state: (userId: string) => ((name: string) => Backend) | undefined; reload: (userId: string) => Promise<void>; status: (userId: string) => Status | undefined; now?: () => number }): Route[] {
  const now = o.now ?? Date.now, pending = new Map<string, { address: string; message: string; exp: number }>();
  const st = (u: string) => { const s = o.state(u); if (!s) throw new SdkError('not_owner', 'this node does not run your account right now', 'Retry in a few seconds.', 503); return s; };
  const view = (u: string) => { const l = readLink(st(u)('solwallet')), s = o.status(u); return { linked: !!l, address: l?.address ?? null, active: !!s?.active, why: s?.active ? null : s?.why ?? null }; };
  return [
    { method: 'GET', path: '/v1/wallet', scope: 'read', summary: 'Your linked Privy wallet and whether this server may trade it now', run: c => view(c.userId) },
    { method: 'POST', path: '/v1/wallet/link/start', scope: 'trade', summary: 'Start linking your Privy Solana wallet: returns a one-time message for the wallet to sign (moves no funds)', body: 'address',
      run: c => { const address = String(c.body?.address ?? '').trim(); if (!looksLikeMint(address)) throw new SdkError('bad_address', 'address must be a Solana address');
        const message = `memedesk: link this wallet to account ${c.userId}.\n\nAddress: ${address}\nNonce: ${randomBytes(16).toString('hex')}\nIssued: ${new Date(now()).toISOString()}\n\nSigning this moves no funds.`;
        pending.set(c.userId, { address, message, exp: now() + 5 * 60_000 }); return { message }; } },
    { method: 'POST', path: '/v1/wallet/link/finish', scope: 'trade', summary: 'Finish linking with the wallet\'s signature of that message (base64). The wallet must already allow this server in Privy (signer + policy)', body: 'address, signature (base64)',
      run: async c => {
        const address = String(c.body?.address ?? '').trim(), p = pending.get(c.userId); pending.delete(c.userId);
        if (!p || p.exp < now() || p.address !== address) throw new SdkError('link_expired', 'no link in progress for this address, or it expired', 'Call /v1/wallet/link/start again.', 410);
        const sig = Buffer.from(String(c.body?.signature ?? ''), 'base64');
        if (sig.length !== 64 || !verifySignature(address, new TextEncoder().encode(p.message), new Uint8Array(sig))) throw new SdkError('bad_signature', 'the signature does not match this address and message', undefined, 401);
        let d; try { d = await o.privy.delegation(address); } catch (e) { throw new SdkError('privy_unavailable', (e as Error).message, 'Retry shortly.', 503); }
        if (!d.ok) throw new SdkError('not_delegated', d.why, 'In your app, call Privy useSigners().addSigners({ address, signers: [{ signerId, policyIds: [policyId] }] }) first.', 409);
        st(c.userId)('solwallet').write(JSON.stringify({ address, walletId: d.walletId, linkedAt: now() } satisfies SolLink));
        await o.reload(c.userId); return view(c.userId);
      } },
    { method: 'DELETE', path: '/v1/wallet', scope: 'trade', summary: 'Unlink the wallet: this server stops trading it (orders stay saved and are refused until a wallet is linked)',
      run: async c => { st(c.userId)('solwallet').write('{}'); await o.reload(c.userId); return view(c.userId); } },
  ];
}
