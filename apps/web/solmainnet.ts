/** REAL-FUNDS SOLANA TRADING FOR THE LOCAL TERMINAL, behind limits and a two-step confirmation (see solguard.ts).
 *  - The wallet key is pasted into the terminal page by the user, held in this process's memory only, and never written to disk, logged or sent back. Restarting the server disconnects the wallet.
 *  - The terminal listens on 127.0.0.1 with no login: anything that can reach that port can use a connected wallet within the limits. Do not expose it, and use a wallet funded only for testing.
 *  - Trades run through the same engine as everywhere else: write-ahead record, policy signer (per-trade and daily caps), simulation before signing, confirmation tracking.
 *  This module is only checked here on a local validator with fake funds. Nothing in this project has made a mainnet trade. */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Engine, Router, Store, PolicySigner, NATIVE } from '../../packages/core/src/index.ts';
import type { WalletPolicy } from '../../packages/core/src/index.ts';
import { randomBytes } from 'node:crypto';
import { SolanaChain, SolJsonRpc, DevSolSigner, RemoteSolSigner, SignRequestError, verifySignature, b58decode, looksLikeMint } from '../../packages/sol/src/index.ts';
import type { SolSigner } from '../../packages/sol/src/index.ts';
import { Trader } from '../../packages/sdk/src/trader.ts';
import { urls } from '../../packages/live/src/config.ts';
import { TradeGuard, GuardError, DEFAULT_LIMITS } from './solguard.ts';
import type { Limits } from './solguard.ts';

const WSOL = 'So11111111111111111111111111111111111111112', BIG = 10n ** 30n;
const TERMINAL = new Set(['finalized', 'failed', 'expired', 'unresolved']);
const bad = (m: string, status = 400) => new GuardError(m, status);

/** Accepts a Solana keypair as a JSON array of 64 numbers (solana-keygen), a base58 string of 64 bytes (wallet export), or a base58 32-byte seed. Returns the 32-byte seed. */
export function parseKey(text: string): Uint8Array {
  const t = text.trim(); let bytes: Uint8Array;
  try { bytes = t.startsWith('[') ? Uint8Array.from(JSON.parse(t) as number[]) : b58decode(t); } catch { throw bad('that does not look like a Solana private key (JSON array or base58)'); }
  if (bytes.length !== 64 && bytes.length !== 32) throw bad(`a Solana key is 32 or 64 bytes, this one is ${bytes.length}`);
  return bytes.length === 64 ? bytes.slice(0, 32) : bytes;
}

export class SolMainnet {
  private guard: TradeGuard; private settingsFile: string;
  private nonces = new Map<string, { message: string; exp: number }>(); private session?: string; private remote?: RemoteSolSigner;
  private conn?: { address: string; signer: SolSigner; chain: SolanaChain; trader: Trader; policy: WalletPolicy; rpc: SolJsonRpc };
  constructor(private dir = join(process.cwd(), '.state', 'sol-mainnet'), private rpcUrl?: string, private families: string[] = ['pump', 'jupiter']) {
    mkdirSync(dir, { recursive: true }); this.settingsFile = join(dir, 'settings.json');
    let init: any; try { init = existsSync(this.settingsFile) ? JSON.parse(readFileSync(this.settingsFile, 'utf8')) : undefined; } catch { init = undefined; }
    const limits: Limits = init?.limits ? { maxTradeLamports: BigInt(init.limits.maxTradeLamports), dailyCapLamports: BigInt(init.limits.dailyCapLamports), maxSlippageBps: Number(init.limits.maxSlippageBps), ticketTtlMs: DEFAULT_LIMITS.ticketTtlMs } : { ...DEFAULT_LIMITS };
    this.guard = new TradeGuard(limits, Date.now, () => this.persist(), { killed: init?.killed, spent: init?.spent });
  }
  private persist() { const l = this.guard.limits; writeFileSync(this.settingsFile, JSON.stringify({ limits: { maxTradeLamports: l.maxTradeLamports.toString(), dailyCapLamports: l.dailyCapLamports.toString(), maxSlippageBps: l.maxSlippageBps }, ...this.guard.snapshot()}, null, 2)); }
  private rpcEndpoint() { if (this.rpcUrl) return this.rpcUrl; const key = process.env.ALCHEMY_API_KEY; if (!key) throw bad('ALCHEMY_API_KEY is not set (see .env.example)', 503); return urls(key).sol; }
  private redact(s: string) { const k = process.env.ALCHEMY_API_KEY; return k ? s.split(k).join('***') : s; }

  async status() {
    const l = this.guard.limits; let balance: string | null = null;
    if (this.conn) { try { balance = BigInt((await this.conn.rpc.call<any>('getBalance', [this.conn.address, { commitment: 'confirmed' }])).value).toString(); } catch { balance = null; } }
    return { connected: !!this.conn, signer: this.remote ? 'wallet' : this.conn ? 'key' : null, address: this.conn?.address ?? null, balanceLamports: balance, killed: this.guard.killed, spentTodayLamports: this.guard.spentToday().toString(),
      limits: { maxTradeLamports: l.maxTradeLamports.toString(), dailyCapLamports: l.dailyCapLamports.toString(), maxSlippageBps: l.maxSlippageBps },
      notice: 'The key lives in this process only (memory). Restarting the server disconnects the wallet. The terminal has no login: use a wallet funded only for testing.' };
  }

  private attach(address: string, signer: SolSigner) {
    if (this.conn) throw bad('a wallet is already connected: disconnect it first', 409);
    const rpc = new SolJsonRpc(this.rpcEndpoint());
    const chain = new SolanaChain({ id: 'sol-main', wsol: WSOL, pools: [], pump: { mints: [] }, jupiter: { pairs: [] } }, rpc, signer);
    const policy: WalletPolicy = { userId: 'u1', chains: ['sol-main'], allowedVenues: this.families, maxPerTx: { [NATIVE]: this.guard.limits.maxTradeLamports }, dailyLimit: { [NATIVE]: this.guard.limits.dailyCapLamports }, destinations: [], deviceSecret: 'local' };
    const store = Store.open(join(this.dir, `engine-${address.slice(0, 8)}.json`));
    const engine = new Engine({ store, chain, signer: new PolicySigner(new Map([[address, 'x']]), new Map([[address, policy]])), router: new Router(chain), platformFeeBps: 0 });
    const trader = new Trader({ engine, chain, userId: 'u1', venues: this.families, persistDir: join(this.dir, `trader-${address.slice(0, 8)}`) });
    this.conn = { address, signer, chain, trader, policy, rpc }; this.session = randomBytes(24).toString('base64url');
  }
  private needSession(b: any) { if (this.session && b?.__session !== this.session) throw bad('sign in again: this browser has no active wallet session', 401); }

  /** Advanced: connect a throwaway wallet from a pasted key. The key is never stored or echoed. */
  async connect(body: any) {
    const seed = parseKey(String(body?.key ?? '')); const signer = new DevSolSigner(), address = signer.add(seed);
    this.attach(address, signer); this.remote = undefined; return { ...(await this.status()), __setSession: this.session };
  }
  /** Wallet login step 1: a one-time message for the wallet to sign. Signing it proves the browser controls the address; it moves no funds and the message says so. */
  authNonce(b: any) {
    const address = String(b?.address ?? '').trim(); if (!looksLikeMint(address)) throw bad('that is not a Solana address');
    const nonce = randomBytes(16).toString('hex'), issued = new Date().toISOString();
    const message = `MINT wants you to sign in with your Solana wallet.\n\nAddress: ${address}\nNonce: ${nonce}\nIssued: ${issued}\n\nThis signature only proves you control this wallet. It does not send funds or approve a trade.`;
    this.nonces.set(address, { message, exp: Date.now() + 5 * 60_000 }); return { message };
  }
  /** Wallet login step 2: verify the signature, then connect that address with a signer that asks the wallet for every transaction. The private key never reaches this server. */
  async authVerify(b: any) {
    const address = String(b?.address ?? '').trim(), n = this.nonces.get(address); this.nonces.delete(address);
    if (!n || n.exp < Date.now()) throw bad('the sign-in request expired: try again', 410);
    let sig: Uint8Array; try { sig = Uint8Array.from(Buffer.from(String(b?.signature ?? ''), 'base64')); } catch { throw bad('bad signature encoding'); }
    if (sig.length !== 64 || !verifySignature(address, new TextEncoder().encode(n.message), sig)) throw bad('the signature does not match this address', 401);
    const remote = new RemoteSolSigner(); this.attach(address, remote); this.remote = remote; return { ...(await this.status()), __setSession: this.session };
  }
  /** Signing requests waiting for the browser wallet. */
  pendingSigns(b: any) { this.needSession(b); if (!this.conn || !this.remote) return { items: [] }; return { items: this.remote.pending(this.conn.address).map(p => ({ id: p.id, wallet: p.wallet, message: Buffer.from(p.message).toString('base64'), expiresAt: p.expiresAt })) }; }
  submitSign(b: any) { this.needSession(b); if (!this.remote) throw bad('no wallet is waiting to sign', 409); try { this.remote.submit(String(b?.id ?? ''), Uint8Array.from(Buffer.from(String(b?.signature ?? ''), 'base64'))); } catch (e) { throw bad((e as Error).message, e instanceof SignRequestError ? 422 : 400); } return { ok: true }; }
  rejectSign(b: any) { this.needSession(b); this.remote?.reject(String(b?.id ?? '')); return { ok: true }; }
  async disconnect(b?: any) { this.needSession(b); this.remote?.cancelAll(); this.remote = undefined; this.conn = undefined; this.session = undefined; return { ...(await this.status()), __setSession: '' }; }
  /** Turning the kill switch ON never needs a session (it is the emergency stop). Turning it off does. */
  killSwitch(on: boolean, b?: any) { if (!on) this.needSession(b); this.guard.setKill(!!on); return this.status(); }

  setLimits(b: any) {
    this.needSession(b);
    const num = (v: unknown, k: string) => { if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) || typeof v === 'number' && v >= 0) return Number(v); throw bad(`${k} must be a number`); };
    const toLam = (sol: number) => BigInt(Math.round(sol * 1e9)); const max = toLam(num(b?.maxTradeSol, 'maxTradeSol')), cap = toLam(num(b?.dailyCapSol, 'dailyCapSol')), slip = num(b?.maxSlippagePct, 'maxSlippagePct') * 100;
    if (max <= 0n || cap < max) throw bad('the daily cap must be at least the per-trade limit, and both above zero'); if (!Number.isInteger(slip) || slip < 0 || slip > 5000) throw bad('slippage must be between 0 and 50 percent, in steps of 0.01');
    this.guard.limits = { ...this.guard.limits, maxTradeLamports: max, dailyCapLamports: cap, maxSlippageBps: slip }; this.persist();
    if (this.conn) { this.conn.policy.maxPerTx[NATIVE] = max; this.conn.policy.dailyLimit[NATIVE] = cap; } return this.status();
  }

  private need() { if (!this.conn) throw bad('connect a wallet first', 409); return this.conn; }
  /** Step 1: check limits, find the best route, quote, and simulate a buy. Nothing is signed or sent. */
  async prepare(b: any) {
    this.needSession(b); const c = this.need(), mint = String(b?.mint ?? '').trim(), side = b?.side === 'sell' ? 'sell' : 'buy'; if (!looksLikeMint(mint)) throw bad('that is not a Solana mint address');
    const lamports = side === 'buy' ? BigInt(Math.round(Number(b?.sol) * 1e9)) : 0n; if (side === 'buy' && !(Number(b?.sol) > 0)) throw bad('enter an amount of SOL above zero');
    const slippageBps = Math.round(Number(b?.slippagePct ?? this.guard.limits.maxSlippageBps / 100) * 100), pctBps = side === 'sell' ? Math.round(Number(b?.pct ?? 0) * 100) : undefined;
    try {
      await c.chain.refresh('venues'); await c.chain.addToken(mint); const vs = c.chain.venues().filter(v => (side === 'buy' ? v.supports(NATIVE, mint) : v.supports(mint, NATIVE)));
      if (!vs.length) throw bad('no venue can trade this token');
      let best = vs[0], bestOut = -1n; if (side === 'buy') for (const v of vs) { const o = v.quote(NATIVE, mint, lamports).amountOut; if (o > bestOut) { bestOut = o; best = v; } }
      const q = side === 'buy' ? best.quote(NATIVE, mint, lamports) : undefined; let sim: { status: string; reason?: string } | undefined;
      if (side === 'buy') { const tx: any = { kind: 'swap', wallet: c.address, venue: best.id, tokenIn: NATIVE, tokenOut: mint, amountIn: lamports, minOut: 0n, platformFeeBps: 0, nonce: 0, hash: '', deadline: 0 }; const r = await c.chain.simulate(tx); sim = { status: r.receipt.status, reason: r.receipt.reason?.slice(0, 240) }; }
      const t = this.guard.prepare({ side, mint, lamports, pctBps, slippageBps, venue: best.family, summary: {} });
      return { ticketId: t.id, expiresInS: Math.round(this.guard.limits.ticketTtlMs / 1000), side, mint, route: best.id, spendLamports: lamports.toString(), expectedOutRaw: q?.amountOut.toString() ?? null, priceImpactPct: q ? q.priceImpactBps / 100 : null, slippagePct: slippageBps / 100, sellPct: pctBps ? pctBps / 100 : null,
        simulation: sim ?? { status: 'not run', reason: 'a sell is simulated by the engine right before signing' }, canConfirm: !sim || sim.status === 'success', notice: 'Nothing has been signed or sent. Confirming will spend real funds from the connected wallet.' };
    } catch (e) { if (e instanceof GuardError) throw e; throw bad(this.redact((e as Error).message), 502); }
  }
  /** Step 2: redeem the ticket and run the trade through the engine. */
  async confirm(b: any) {
    this.needSession(b); const c = this.need(); if (b?.ack !== true) throw bad('confirmation needs ack: true');
    const t = this.guard.redeem(String(b?.ticketId ?? '')); c.policy.maxPerTx[t.mint] = BIG; c.policy.dailyLimit[t.mint] = BIG; const key = `solmain:${t.id}`;
    try {
      await c.chain.refresh('venues');   // the engine's deadlines use the chain's clock: bring it up to date right before trading
      let v = t.side === 'buy' ? await c.trader.buy({ walletId: c.address, token: t.mint, amount: t.lamports, slippageBps: t.slippageBps, key }) : await c.trader.sell({ walletId: c.address, token: t.mint, pctBps: t.pctBps!, slippageBps: t.slippageBps, key });
      for (let i = 0; i < 90 && !TERMINAL.has(v.state) && v.state !== 'confirmed'; i++) { await new Promise(r => setTimeout(r, 1000)); v = await c.trader.advance(key); }
      const sent = v.history.some(h => h.state === 'submitted'); if (!sent && v.state === 'failed') this.guard.refund(t);
      return { ok: v.state !== 'failed', state: v.state, sent, signature: v.txHash ?? null, explorer: v.txHash ? `https://solscan.io/tx/${v.txHash}` : null, failure: v.failure ? this.redact(v.failure) : null, key };
    } catch (e) { this.guard.refund(t); throw bad(this.redact((e as Error).message), 502); }
  }
}
