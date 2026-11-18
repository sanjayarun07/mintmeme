/** PRIVY DELEGATED SIGNING: the server signs a user's trades with the user's own Privy wallet, inside the limits the user agreed to, without the browser open.
 *  How: in the browser the user adds this app's authorization key as a signer on their Privy wallet, with this app's policy attached (useSigners().addSigners). The server
 *  then asks Privy to sign each transaction (POST /v1/wallets/{id}/rpc, method signTransaction) with a request signed by that authorization key. Privy checks the policy
 *  (allowed programs, SOL cap) inside its TEE before signing. The private key never leaves Privy; the user can remove the signer at any time (removeSigners).
 *  This signer only signs: the engine still sends, tracks and confirms the transaction, exactly as with any other signer. Every signature Privy returns is checked
 *  against the wallet's public key and the exact message the engine built, so a changed transaction is never accepted.
 *  Request format from Privy's own SDK types (@privy-io/api-types: SolanaSignTransactionRpcInput, Wallet.additional_signers) and its request-signing code (@privy-io/js-sdk-core). */
import { createPrivateKey, sign as ecSign } from 'node:crypto';
import { verifySignature } from './signer.ts';
import type { SolSigner } from './signer.ts';
import { SignRequestError } from './remotesigner.ts';

export interface PrivyConfig {
  appId: string; appSecret: string;
  /** The authorization private key from the dashboard ("wallet-auth:" + base64 PKCS#8), and the id of its key quorum: the signer the user adds to their wallet. */
  authKey: string; signerId: string;
  /** The policy the user attaches when adding the signer. A wallet whose signer carries another policy (or none) is refused. */
  policyId: string;
  apiUrl?: string; fetchFn?: typeof fetch; timeoutMs?: number;
  /** Which wallets this client works with: 'solana' (default, method signTransaction) or 'ethereum' (EVM chains such as Base, method eth_signTransaction). */
  chainType?: 'solana' | 'ethereum';
}

/** RFC 8785 JSON canonicalization for the values Privy requests carry (objects, arrays, strings, integers, booleans, null). Keys sort by UTF-16 code units, as JS sort does. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object') return '{' + Object.keys(v).filter(k => (v as any)[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical((v as any)[k])).join(',') + '}';
  if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new Error('canonical: only safe integers are supported');
  return JSON.stringify(v);
}

/** The privy-authorization-signature header: ECDSA P-256 / SHA-256 (DER, base64) over the canonical JSON of the request. */
export function authorizationSignature(authKey: string, appId: string, method: 'POST', url: string, body: unknown): string {
  const key = createPrivateKey({ key: Buffer.from(authKey.trim().replace(/^wallet-auth:/, ''), 'base64'), format: 'der', type: 'pkcs8' });
  return ecSign('sha256', Buffer.from(canonical({ version: 1, method, url, body, headers: { 'privy-app-id': appId } })), key).toString('base64');
}

export class PrivyError extends Error { constructor(msg: string, public status: number) { super(msg); } }

export class PrivyApi {
  private base: string;
  constructor(private c: PrivyConfig) { this.base = (c.apiUrl ?? 'https://api.privy.io').replace(/\/$/, ''); }
  private async req(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
    const url = this.base + path, headers: Record<string, string> = { authorization: 'Basic ' + Buffer.from(`${this.c.appId}:${this.c.appSecret}`).toString('base64'), 'privy-app-id': this.c.appId };
    if (method === 'POST') { headers['content-type'] = 'application/json'; headers['privy-authorization-signature'] = authorizationSignature(this.c.authKey, this.c.appId, 'POST', url, body); }
    let r: Response; try { r = await (this.c.fetchFn ?? fetch)(url, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(this.c.timeoutMs ?? 15_000) }); }
    catch (e) { throw new PrivyError(`Privy did not answer: ${(e as Error).message}`, 503); }
    const text = await r.text(); let j: any; try { j = JSON.parse(text); } catch { j = undefined; }
    if (!r.ok) throw new PrivyError(`Privy refused (${r.status}): ${String(j?.error ?? j?.message ?? text).slice(0, 300)}`, r.status);
    return j;
  }
  get chainType() { return this.c.chainType ?? 'solana'; }
  /** The method this client signs with (what the policy must ALLOW). */
  get signMethod() { return this.chainType === 'ethereum' ? 'eth_signTransaction' : 'signTransaction'; }
  /** The Privy wallet with this address (Solana, or 0x for ethereum: compared without case), or undefined when this app has none. */
  async walletByAddress(address: string): Promise<{ id: string; address: string; additional_signers?: { signer_id: string; override_policy_ids?: string[] }[] } | undefined> {
    const j = await this.req('GET', `/v1/wallets?chain_type=${this.chainType}&address=${encodeURIComponent(address)}`);
    const same = (a: unknown) => typeof a === 'string' && (this.chainType === 'ethereum' ? a.toLowerCase() === address.toLowerCase() : a === address);
    return (j?.data ?? []).find((w: any) => same(w?.address));
  }
  /** Whether the user has added this app's signer, with this app's policy, to the wallet at `address`. */
  async delegation(address: string): Promise<{ ok: true; walletId: string } | { ok: false; why: string }> {
    const w = await this.walletByAddress(address);
    if (!w) return { ok: false, why: 'This address is not a Privy wallet of this app. Automatic trading works only with your Privy wallet.' };
    const s = (w.additional_signers ?? []).find(x => x.signer_id === this.c.signerId);
    if (!s) return { ok: false, why: 'Your Privy wallet has not allowed automatic trading yet (the server signer is not on it).' };
    if (!(s.override_policy_ids ?? []).includes(this.c.policyId)) return { ok: false, why: 'The server signer on your wallet is not limited by this app\'s trading policy. Revoke it and allow automatic trading again.' };
    // the server signs with method signTransaction / eth_signTransaction (the engine sends the transaction itself): a policy without an ALLOW rule for it denies every trade
    const p = await this.req('GET', `/v1/policies/${encodeURIComponent(this.c.policyId)}`), m = this.signMethod;
    if (!(p?.rules ?? []).some((r: any) => r?.action === 'ALLOW' && (r.method === m || r.method === '*'))) return { ok: false, why: `The trading policy has no ALLOW rule for the method ${m}, which this server uses, so Privy would refuse every trade. In the Privy dashboard, set the method of the policy's rules to ${m} (README → ${this.chainType === 'ethereum' ? 'Base' : 'Solana'} policy rules).` };
    return { ok: true, walletId: w.id };
  }
  /** Privy signs a serialized transaction (base64, signatures zeroed) and returns it signed. */
  async signTransaction(walletId: string, txBase64: string): Promise<string> {
    const j = await this.req('POST', `/v1/wallets/${encodeURIComponent(walletId)}/rpc`, { method: 'signTransaction', params: { transaction: txBase64, encoding: 'base64' } });
    const out = j?.data?.signed_transaction; if (typeof out !== 'string') throw new PrivyError('Privy answered without a signed transaction', 502); return out;
  }
  /** EVM: Privy signs an unsigned type-2 transaction (fields as in @privy-io/api-types UnsignedStandardEthereumTransaction) and returns the signed RLP hex. */
  async signEthTransaction(walletId: string, transaction: Record<string, string | number>): Promise<string> {
    const j = await this.req('POST', `/v1/wallets/${encodeURIComponent(walletId)}/rpc`, { method: 'eth_signTransaction', params: { transaction } });
    const out = j?.data?.signed_transaction; if (typeof out !== 'string') throw new PrivyError('Privy answered without a signed transaction', 502); return out;
  }
}

/** A SolSigner backed by Privy. `wallets` maps each address it may sign for to its Privy wallet id (checked with PrivyApi.delegation first). */
export class PrivySolSigner implements SolSigner {
  constructor(private api: PrivyApi, private wallets: Map<string, string>) {}
  async sign(wallet: string, message: Uint8Array): Promise<Uint8Array> {
    const id = this.wallets.get(wallet); if (!id) throw new SignRequestError(`no Privy wallet is set up for ${wallet.slice(0, 6)}...: nothing was sent`);
    const n = message[0] & 0x80 ? message[1] : message[0];   // required signatures: v0 messages start with a version byte
    if (n < 1 || n > 127) throw new SignRequestError('unexpected transaction: nothing was sent');
    const unsigned = Buffer.concat([Buffer.of(n), Buffer.alloc(64 * n), message]);
    let signed: Buffer; try { signed = Buffer.from(await this.api.signTransaction(id, unsigned.toString('base64')), 'base64'); }
    catch (e) { throw new SignRequestError(`${(e as Error).message}: nothing was sent`); }
    // the fee payer (the wallet) is the first signer; the rest of the bytes must be the message the engine built
    const sig = new Uint8Array(signed.subarray(1, 65));
    if (signed[0] !== n || !signed.subarray(1 + 64 * n).equals(Buffer.from(message)) || !verifySignature(wallet, message, sig)) throw new SignRequestError('Privy returned a signature that does not match this transaction: nothing was sent');
    return sig;
  }
}
