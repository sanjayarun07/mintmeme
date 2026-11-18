/** REAL BASE ACCOUNTS for the execution server (MODE=base-mainnet). The Base twin of solaccount.ts: each API user links their own Privy Ethereum wallet; the node that
 *  owns the user runs `createBaseTrader` (packages/sdk/src/base.ts) over the user's Redis state. Trades are signed by Privy within the Base policy the user agreed to and
 *  the ETH caps; every signed transaction is checked field by field and by its recovered signer before it is sent. No private key is ever held by a node.
 *
 *  Linking: POST /v1/wallet/link/start {address} -> a one-time message; the wallet signs it with personal_sign; POST /v1/wallet/link/finish {address, signature (0x, 65
 *  bytes)}: the signer is recovered from the signature (proves this API user controls the wallet), then Privy is asked whether the wallet carries this server's signer
 *  with the Base policy. Only then is {address, walletId} saved under the user. GET /v1/wallet shows the link; DELETE /v1/wallet removes it. */
import { randomBytes } from 'node:crypto';
import type { Backend } from '../../packages/core/src/index.ts';
import { PrivyApi } from '../../packages/sol/src/index.ts';
import type { PrivyConfig } from '../../packages/sol/src/index.ts';
import { isAddress, personalSigner } from '../../packages/evm/src/index.ts';
import type { RpcLike } from '../../packages/evm/src/index.ts';
import { createBaseTrader, baseEthUsd, EvmJsonRpc } from '../../packages/sdk/src/base.ts';
import { SdkError } from '../../packages/sdk/src/wire.ts';
import type { Account } from './node.ts';
import type { Route } from '../api/server.ts';

export interface BaseLink { address: string; walletId: string; linkedAt: number }
export const readBaseLink = (b: Backend): BaseLink | undefined => { try { const j = JSON.parse(b.read() ?? ''); return j && isAddress(j.address) && typeof j.walletId === 'string' ? j : undefined; } catch { return undefined; } };
type Status = { address?: string; active: boolean; why?: string };
/** Routes that spend or sell from the wallet (refused while the wallet is not active). */
const TRADE_PATHS = /^\/v1\/(trades\/(buy|sell)$|orders\/[a-z-]+$|twap$|bulk\/(buy|sell)$)/;

/** The account factory. A user with no linked (or no longer delegated) wallet still gets an account: reads work, every trade is refused with the reason. */
export function baseAccounts(c: { rpcUrl: string; privy: PrivyConfig; caps?: { maxTradeWei: bigint; dailyCapWei: bigint }; rpc?: RpcLike; log?: (m: string) => void }) {
  const privy = new PrivyApi({ ...c.privy, chainType: 'ethereum' }), rpc = c.rpc ?? new EvmJsonRpc(c.rpcUrl), ethUsd = baseEthUsd(rpc), status = new Map<string, Status>();
  const make = async (userId: string, state: (name: string) => Backend): Promise<Account> => {
    const link = readBaseLink(state('basewallet'));
    const s = await createBaseTrader({ userId, address: link?.address, walletId: link?.walletId, rpcUrl: c.rpcUrl, rpc, privy, state, caps: c.caps, ethUsd, log: c.log });
    status.set(userId, { address: link?.address, active: s.active, why: s.active ? undefined : (link ? s.why : 'No wallet is linked. Link your Privy Ethereum wallet: POST /v1/wallet/link/start, then /v1/wallet/link/finish.') });
    return { trader: s.trader, prepare: async (raw: any, path: string) => {
      const trades = TRADE_PATHS.test(path); if (trades) s.refuseIfInactive();
      if (raw && typeof raw === 'object' && raw.token === undefined && typeof raw.mint === 'string') { raw = { ...raw, token: raw.mint }; delete raw.mint; }   // 'mint' works too
      const tok = raw?.token; if (typeof tok === 'string') await s.prepare(tok);   // finds the token's V2 pool and its decimals (plain units need them)
      const body = await s.simple(path, raw);
      if (trades || typeof tok === 'string') await s.sync();   // chain clock (deadlines) and pool reserves (quotes) as of now
      return body;
    } };
  };
  return { make, status: (u: string) => status.get(u), privy };
}

/** The wallet-linking routes for Base. `state(user)` gives the owner node's durable state for that user; `reload(user)` rebuilds its account. */
export function baseLinkRoutes(o: { privy: PrivyApi; state: (userId: string) => ((name: string) => Backend) | undefined; reload: (userId: string) => Promise<void>; status: (userId: string) => Status | undefined; now?: () => number }): Route[] {
  const now = o.now ?? Date.now, pending = new Map<string, { address: string; message: string; exp: number }>();
  const st = (u: string) => { const s = o.state(u); if (!s) throw new SdkError('not_owner', 'this node does not run your account right now', 'Retry in a few seconds.', 503); return s; };
  const view = (u: string) => { const l = readBaseLink(st(u)('basewallet')), s = o.status(u); return { chain: 'base', linked: !!l, address: l?.address ?? null, active: !!s?.active, why: s?.active ? null : s?.why ?? null }; };
  return [
    { method: 'GET', path: '/v1/wallet', scope: 'read', summary: 'Your linked Privy wallet on Base and whether this server may trade it now', run: c => view(c.userId) },
    { method: 'POST', path: '/v1/wallet/link/start', scope: 'trade', summary: 'Start linking your Privy Ethereum wallet: returns a one-time message for the wallet to sign with personal_sign (moves no funds)', body: 'address',
      run: c => { const address = String(c.body?.address ?? '').trim().toLowerCase(); if (!isAddress(address)) throw new SdkError('bad_address', 'address must be a 0x Ethereum address');
        const message = `memedesk: link this wallet to account ${c.userId} on Base.\n\nAddress: ${address}\nNonce: ${randomBytes(16).toString('hex')}\nIssued: ${new Date(now()).toISOString()}\n\nSigning this moves no funds.`;
        pending.set(c.userId, { address, message, exp: now() + 5 * 60_000 }); return { message }; } },
    { method: 'POST', path: '/v1/wallet/link/finish', scope: 'trade', summary: 'Finish linking with the personal_sign signature of that message (0x, 65 bytes). The wallet must already allow this server in Privy (signer + Base policy)', body: 'address, signature (0x hex)',
      run: async c => {
        const address = String(c.body?.address ?? '').trim().toLowerCase(), p = pending.get(c.userId); pending.delete(c.userId);
        if (!p || p.exp < now() || p.address !== address) throw new SdkError('link_expired', 'no link in progress for this address, or it expired', 'Call /v1/wallet/link/start again.', 410);
        let who = ''; try { who = personalSigner(p.message, String(c.body?.signature ?? '')); } catch { /* reported below */ }
        if (who !== address) throw new SdkError('bad_signature', 'the signature does not match this address and message', undefined, 401);
        let d; try { d = await o.privy.delegation(address); } catch (e) { throw new SdkError('privy_unavailable', (e as Error).message, 'Retry shortly.', 503); }
        if (!d.ok) throw new SdkError('not_delegated', d.why, 'In your app, call Privy useSigners().addSigners({ address, signers: [{ signerId, policyIds: [basePolicyId] }] }) first.', 409);
        st(c.userId)('basewallet').write(JSON.stringify({ address, walletId: d.walletId, linkedAt: now() } satisfies BaseLink));
        await o.reload(c.userId); return view(c.userId);
      } },
    { method: 'DELETE', path: '/v1/wallet', scope: 'trade', summary: 'Unlink the wallet: this server stops trading it (orders stay saved and are refused until a wallet is linked)',
      run: async c => { st(c.userId)('basewallet').write('{}'); await o.reload(c.userId); return view(c.userId); } },
  ];
}
