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
import { SolanaChain, SolJsonRpc, DevSolSigner, RemoteSolSigner, SignRequestError, verifySignature, b58decode, looksLikeMint, mintFacts, compileLegacy, systemTransfer, wireTx } from '../../packages/sol/src/index.ts';
import type { SolSigner } from '../../packages/sol/src/index.ts';
import { fetchJupiterQuote } from '../../packages/sol/src/jupiter.ts';
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

/** Hard ceilings for the server-held trading key. Settings cannot go above these. */
export const TRADING_KEY_CAPS = { maxTradeLamports: 50_000_000n, dailyCapLamports: 250_000_000n, maxBalanceLamports: 500_000_000n };

export class SolMainnet {
  private keyExpiry?: number;
  private guard: TradeGuard; private settingsFile: string;
  private ticker?: ReturnType<typeof setInterval>; private ticking = false; private decs = new Map<string, number>();
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
      tradingKey: this.tradingKeyInfo(), notice: 'The key lives in this process only (memory). Restarting the server disconnects the wallet. The terminal has no login: use a wallet funded only for testing.' };
  }

  private attach(address: string, signer: SolSigner) {
    if (this.conn) throw bad('a wallet is already connected: disconnect it first', 409);
    const rpc = new SolJsonRpc(this.rpcEndpoint());
    const chain = new SolanaChain({ id: 'sol-main', wsol: WSOL, pools: [], pump: { mints: [] }, jupiter: { pairs: [] } }, rpc, signer);
    const policy: WalletPolicy = { userId: 'u1', chains: ['sol-main'], allowedVenues: this.families, maxPerTx: { [NATIVE]: this.guard.limits.maxTradeLamports }, dailyLimit: { [NATIVE]: this.guard.limits.dailyCapLamports }, destinations: [], deviceSecret: 'local' };
    const store = Store.open(join(this.dir, `engine-${address.slice(0, 8)}.json`));
    const engine = new Engine({ store, chain, signer: new PolicySigner(new Map([[address, 'x']]), new Map([[address, policy]])), router: new Router(chain), platformFeeBps: 0 });
    const trader = new Trader({ engine, chain, userId: 'u1', venues: this.families, persistDir: join(this.dir, `trader-${address.slice(0, 8)}`), usd: this.usdFeed() });
    this.conn = { address, signer, chain, trader, policy, rpc }; this.session = randomBytes(24).toString('base64url');
    // Orders and TWAP slices are evaluated by this loop. While the kill switch is on nothing is evaluated, so nothing new fires. A wallet-signed order needs the browser open to approve each fire.
    this.ticker = setInterval(() => { void this.tickOnce(); }, 2000); (this.ticker as any).unref?.();
    void this.reloadTokens();
  }
  private needSession(b: any) { if (this.session && b?.__session !== this.session) throw bad('sign in again: this browser has no active wallet session', 401); }

  /** Advanced: connect a throwaway wallet from a pasted key. The key is never stored or echoed. */
  async connect(body: any) {
    const seed = parseKey(String(body?.key ?? '')); const signer = new DevSolSigner(), address = signer.add(seed);
    this.attach(address, signer); this.remote = undefined; return { ...(await this.status()), __setSession: this.session };
  }
  // ---- Trading key: a separate throwaway wallet the server holds so orders can fire without the browser open. Not your main wallet: you fund it with a small amount. ----
  private keyFile() { return join(this.dir, 'trading-key.json'); }
  private readKey(): { seed: Uint8Array; address: string; createdAt: number; expiresAt: number } | undefined {
    try { const j = JSON.parse(readFileSync(this.keyFile(), 'utf8')); const kp = Uint8Array.from(j.keypair as number[]); return { seed: kp.slice(0, 32), address: String(j.address), createdAt: Number(j.createdAt), expiresAt: Number(j.expiresAt) }; } catch { return undefined; }
  }
  /** Public facts about the saved trading key (never the key itself). */
  tradingKeyInfo() {
    const k = this.readKey(); const c = TRADING_KEY_CAPS;
    return { exists: !!k, address: k?.address ?? null, expiresAt: k?.expiresAt ?? null, expired: k ? k.expiresAt < Date.now() : false, active: !!this.conn && this.conn.address === k?.address && !this.remote,
      maxTradeSol: Number(c.maxTradeLamports) / 1e9, dailyCapSol: Number(c.dailyCapLamports) / 1e9, maxBalanceSol: Number(c.maxBalanceLamports) / 1e9, file: '.state/sol-mainnet/trading-key.json' };
  }
  /** Create a new trading key (refused when one exists, so a funded key is never overwritten). Saved on this computer as a Solana CLI keypair file (mode 0600) so funds can always be recovered by importing it. */
  tradingKeyCreate(b: any) {
    if (this.readKey()) throw bad('a trading key already exists. Use it, or move the file away yourself to make a new one', 409);
    const hours = Math.min(168, Math.max(1, Number(b?.hours ?? 24) || 24)), signer = new DevSolSigner(), seed = randomBytes(32), address = signer.add(seed);
    const keypair = Array.from(Buffer.concat([seed, b58decode(address)]));
    writeFileSync(this.keyFile(), JSON.stringify({ address, keypair, createdAt: Date.now(), expiresAt: Date.now() + hours * 3_600_000, note: 'Solana CLI keypair. Import it into a wallet to recover any funds. Never share it.' }), { mode: 0o600 });
    return this.tradingKeyInfo();
  }
  /** Connect the saved trading key. Orders then fire on their own while the server runs, within the limits, until the key expires or the kill switch is turned on. */
  /** Send a little SOL from the signed-in WALLET to the trading key, so the key can trade. This is the one place the terminal moves SOL that is not a swap, so it is deliberately narrow:
   *  the destination is read from the trading key's own file and is never taken from the request; one funding is at most TRADING_KEY_CAPS.maxTradeLamports (0.05 SOL) and the key's
   *  balance may never exceed TRADING_KEY_CAPS.maxBalanceLamports (0.5 SOL); it needs a connected wallet that signs in the browser (a key cannot fund itself), the kill switch off, and an
   *  explicit ack. The transaction is built here, the wallet shows it and signs it, and the signature is verified against these exact bytes before anything is sent. */
  async fundTradingKey(b: any) {
    this.needSession(b); const c = this.need();
    if (!this.remote) throw bad('Fund the trading key from a signed-in wallet. A trading key cannot fund itself.', 409);
    if (this.guard.killed) throw bad('The kill switch is on. Turn it off to move SOL.', 403);
    const k = this.readKey(); if (!k) throw bad('Create the trading key first.', 409);
    if (k.expiresAt < Date.now()) throw bad('The trading key has expired. Move the file away and create a new one.', 409);
    if (c.address === k.address) throw bad('The signed-in wallet is the trading key itself.', 409);
    const lamports = this.units(b?.sol, 9, 'amount in SOL'), MIN = 1_000_000n, cap = TRADING_KEY_CAPS;
    if (lamports < MIN) throw bad('The smallest funding is 0.001 SOL (a new account must hold at least about that much).');
    if (lamports > cap.maxTradeLamports) throw bad(`One funding is at most ${Number(cap.maxTradeLamports) / 1e9} SOL.`);
    if (b?.ack !== true) throw bad('Tick the confirmation box first.');
    const bal = async (a: string) => BigInt((await c.rpc.call<any>('getBalance', [a, { commitment: 'confirmed' }])).value);
    const keyBal = await bal(k.address); if (keyBal + lamports > cap.maxBalanceLamports) throw bad(`The trading key may hold at most ${Number(cap.maxBalanceLamports) / 1e9} SOL. It holds ${Number(keyBal) / 1e9} now.`);
    if ((await bal(c.address)) < lamports + 10_000n) throw bad('The wallet does not hold enough SOL for this and the network fee.');
    const t = await this.transfer(c, k.address, lamports);
    return { ...t, keyBalanceSol: Number(await bal(k.address).catch(() => keyBal)) / 1e9 };
  }
  /** Build one System transfer from the connected signer, have it signed (by the browser wallet or the key), send it and wait for confirmation. Callers check every limit first. */
  private async transfer(c: NonNullable<SolMainnet['conn']>, to: string, lamports: bigint) {
    const bh: any = await c.rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const message = compileLegacy(c.address, [systemTransfer(c.address, to, lamports)], b58decode(bh.value.blockhash));
    let signature: Uint8Array; try { signature = await c.signer.sign(c.address, message); } catch (e) { if (e instanceof SignRequestError) throw bad(e.message, 409); throw e; }
    const raw = Buffer.from(wireTx(message, [signature])).toString('base64');
    let hash: string; try { hash = await c.rpc.call<string>('sendTransaction', [raw, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }]); } catch (e) { throw bad('The network refused the transfer: ' + this.redact((e as Error).message).slice(0, 200), 502); }
    let state = 'submitted'; for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 1500)); const s: any = (await c.rpc.call<any>('getSignatureStatuses', [[hash], { searchTransactionHistory: true }])).value[0]; if (s?.err) { state = 'failed'; break; } if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') { state = s.confirmationStatus; break; } }
    this.histCache = undefined;
    return { ok: state !== 'failed', state, signature: hash, explorer: `https://solscan.io/tx/${hash}`, from: c.address, to, sol: Number(lamports) / 1e9 };
  }
  /** Wallets that sent SOL to the trading key, read from the chain (its last 50 transactions). Only these may receive SOL back from it, so the key can never pay a stranger. */
  async keyFunders(): Promise<string[]> {
    const k = this.readKey(); if (!k) return []; const c = this.need(); const out = new Set<string>();
    const sigs: any[] = await c.rpc.call('getSignaturesForAddress', [k.address, { limit: 50, commitment: 'confirmed' }]);   // 'confirmed', not the default 'finalized': a funding made seconds ago must count
    for (const s of sigs) { if (s.err) continue; const tx: any = await c.rpc.call('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null);
      for (const ix of tx?.transaction?.message?.instructions ?? []) if (ix.program === 'system' && ix.parsed?.type === 'transfer' && ix.parsed.info?.destination === k.address && ix.parsed.info?.source !== k.address) out.add(String(ix.parsed.info.source)); }
    return [...out];
  }
  /** Send all of the trading key's SOL (less the network fee) back to a wallet that funded it. Needs the key connected and an ack. Allowed with the kill switch on: taking money out is always safe.
   *  Tokens the key holds are not moved here: sell them first. */
  async tradingKeyReturn(b: any) {
    this.needSession(b); const c = this.need(); const k = this.readKey();
    if (!k || c.address !== k.address || this.remote) throw bad('Connect the trading key first (Use trading key). Only the key can send its own SOL.', 409);
    if (b?.ack !== true) throw bad('Tick the confirmation box first.');
    const to = String(b?.to ?? ''), funders = await this.keyFunders();
    if (!funders.includes(to)) throw bad('SOL can only go back to a wallet that funded this key.', 403);
    const FEE = 5_000n, bal = BigInt((await c.rpc.call<any>('getBalance', [k.address, { commitment: 'confirmed' }])).value);
    if (bal <= FEE) throw bad('The trading key holds no SOL to return.', 409);
    return this.transfer(c, to, bal - FEE);
  }
  async tradingKeyUse() {
    const k = this.readKey(); if (!k) throw bad('create a trading key first', 404); if (k.expiresAt < Date.now()) throw bad('this trading key has expired. Create a new one (move the old file away first, after taking any funds out)', 410);
    const signer = new DevSolSigner(); if (signer.add(k.seed) !== k.address) throw bad('the saved trading key is damaged', 500);
    // Hard ceilings for this mode: limits are lowered to them, never raised.
    const l = this.guard.limits, c = TRADING_KEY_CAPS; if (l.maxTradeLamports > c.maxTradeLamports || l.dailyCapLamports > c.dailyCapLamports) { this.guard.limits = { ...l, maxTradeLamports: l.maxTradeLamports > c.maxTradeLamports ? c.maxTradeLamports : l.maxTradeLamports, dailyCapLamports: l.dailyCapLamports > c.dailyCapLamports ? c.dailyCapLamports : l.dailyCapLamports }; this.persist(); }
    this.attach(k.address, signer); this.remote = undefined; this.keyExpiry = k.expiresAt;
    try { const bal = BigInt((await this.conn!.rpc.call<any>('getBalance', [k.address, { commitment: 'confirmed' }])).value); if (bal > c.maxBalanceLamports) { await this.drop(); throw bad(`this key holds ${Number(bal) / 1e9} SOL. The trading key is limited to ${Number(c.maxBalanceLamports) / 1e9} SOL: move the rest out first`, 422); } } catch (e) { if (e instanceof GuardError) throw e; }
    return { ...(await this.status()), __setSession: this.session };
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
  async disconnect(b?: any) { this.needSession(b); return this.drop(); }
  private async drop() { this.keyExpiry = undefined; if (this.ticker) clearInterval(this.ticker); this.ticker = undefined; this.remote?.cancelAll(); this.remote = undefined; this.conn = undefined; this.session = undefined; return { ...(await this.status()), __setSession: '' }; }
  /** Turning the kill switch ON never needs a session (it is the emergency stop). Turning it off does. */
  killSwitch(on: boolean, b?: any) { if (!on) this.needSession(b); this.guard.setKill(!!on); return this.status(); }

  setLimits(b: any) {
    this.needSession(b);
    const num = (v: unknown, k: string) => { if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) || typeof v === 'number' && v >= 0) return Number(v); throw bad(`${k} must be a number`); };
    const toLam = (sol: number) => BigInt(Math.round(sol * 1e9)); const max = toLam(num(b?.maxTradeSol, 'maxTradeSol')), cap = toLam(num(b?.dailyCapSol, 'dailyCapSol')), slip = num(b?.maxSlippagePct, 'maxSlippagePct') * 100;
    if (max <= 0n || cap < max) throw bad('the daily cap must be at least the per-trade limit, and both above zero');
    if (this.keyExpiry !== undefined && (max >TRADING_KEY_CAPS.maxTradeLamports || cap > TRADING_KEY_CAPS.dailyCapLamports)) throw bad(`with the trading key, the limits cannot exceed ${Number(TRADING_KEY_CAPS.maxTradeLamports) / 1e9} SOL per trade and ${Number(TRADING_KEY_CAPS.dailyCapLamports) / 1e9} SOL per day`); if (!Number.isInteger(slip) || slip < 0 || slip > 5000) throw bad('slippage must be between 0 and 50 percent, in steps of 0.01');
    this.guard.limits = { ...this.guard.limits, maxTradeLamports: max, dailyCapLamports: cap, maxSlippageBps: slip }; this.persist();
    if (this.conn) { this.conn.policy.maxPerTx[NATIVE] = max; this.conn.policy.dailyLimit[NATIVE] = cap; } return this.status();
  }


  private async tickOnce() { const c = this.conn; if (c && this.keyExpiry && !this.remote && Date.now() > this.keyExpiry) { await this.drop(); return; }
    if (!c || this.ticking || this.guard.killed) return; this.ticking = true; try { this.openSellPolicy(c); await c.chain.refresh('venues'); await c.trader.tick(); } catch { /* the next tick retries; a failed evaluation never trades */ } finally { this.ticking = false; } }
  /** After a restart the engine reloads saved orders; make sure their tokens have venues again. */
  /** The policy signer's per-tx and daily limits are written in SOL (the native token). A SELL spends the token being sold, which has no SOL-denominated entry, so the signer
   *  refused every order-fired sell ("exceeds per-tx limit"; seen on mainnet 2026-11-17). Selling tokens you hold is capped by your balance, and the proceeds come back to your own wallet,
   *  so a token being sold by one of your active sell-side orders gets the same open entry a confirmed market sell gets. BUYS are unchanged: they still count against the SOL limits. */
  private openSellPolicy(c: { trader: Trader; policy: WalletPolicy }) {
    const sells = new Set(['limit_sell', 'take_profit', 'stop_loss', 'trailing_stop']);   // a bracket is a take_profit plus a stop_loss
    for (const o of c.trader.listOrders({ status: 'active' })) if (sells.has(o.kind)) { c.policy.maxPerTx[o.token] = BIG; c.policy.dailyLimit[o.token] = BIG; }
  }
  private async reloadTokens() { const c = this.conn; if (!c) return; try { await c.chain.refresh('venues'); for (const m of new Set([...c.trader.listOrders({ status: 'active' }).map(o => o.token), ...c.trader.listTwaps().filter(t => !t.done && !t.cancelled).map(() => '')].filter(Boolean))) await c.chain.addToken(m); } catch { /* shown as "no venue" on the order until it works */ } }
  private async decimals(mint: string) { let d = this.decs.get(mint); if (d === undefined) { d = (await mintFacts(this.need().rpc, mint)).decimals ?? 0; this.decs.set(mint, d); } return d; }
  private async tokenBalance(mint: string) { const c = this.need(); const r = await c.rpc.call<any>('getTokenAccountsByOwner', [c.address, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]); return (r.value as any[]).reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n); }
  private units(v: unknown, dec: number, what: string): bigint { let t = String(v ?? '').trim(); if (/e/i.test(t)) { const n = Number(t); if (!Number.isFinite(n) || n <= 0) throw bad(`${what} must be a positive number`); t = n.toFixed(30).replace(/0+$/, '').replace(/\.$/, ''); } if (!/^\d+(\.\d+)?$/.test(t)) throw bad(`${what} must be a positive number`); const [i, f = ''] = t.split('.'); const out = BigInt(i + f.slice(0, dec).padEnd(dec, '0')); if (out <= 0n) throw bad(`${what} must be above zero`); return out; }
  private priceE18(solPerToken: unknown, dec: number, what: string) { return this.units(solPerToken, 27 - dec, what); }   // SOL per token -> lamports per raw unit x 1e18
  private solPerToken(e18: bigint, dec: number) { return Number(e18) / 1e18 * 10 ** dec / 1e9; }

  private usdCache?: { v: number; t: number };
  /** SOL price in USD from a read-only Jupiter quote of 1 SOL into USDC (cached 30 s). Null when unavailable: the page then shows SOL only. */
  async solUsd(): Promise<number | null> {
    if (this.usdCache && Date.now() - this.usdCache.t < 30_000) return this.usdCache.v;
    try {
      const q = await fetchJupiterQuote({ inputMint: 'So11111111111111111111111111111111111111112', outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: 1_000_000_000n, slippageBps: 50, timeoutMs: 8000 });
      const v = Number(q.outAmount) / 1e6; if (!(v > 0)) return null; this.usdCache = { v, t: Date.now() }; return v;
    } catch { return this.usdCache?.v ?? null; }
  }
  private holdCache?: { key: string; t: number; out: any };
  /** Every token the connected wallet holds (classic and Token-2022 accounts), with a read-only Jupiter quote into SOL for the value. Quotes are best effort: a token with no route shows its balance and no value. Cached 60 s. */
  async holdings(b: any) {
    this.needSession(b); const c = this.need();
    if (this.holdCache && this.holdCache.key === c.address && Date.now() - this.holdCache.t < 60_000) return this.holdCache.out;
    const by = new Map<string, { raw: bigint; dec: number }>();
    for (const programId of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
      const r = await c.rpc.call<any>('getTokenAccountsByOwner', [c.address, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      for (const a of r.value as any[]) { const i = a.account.data.parsed.info, amt = BigInt(i.tokenAmount.amount); if (amt <= 0n) continue; const cur = by.get(i.mint); by.set(i.mint, { raw: (cur?.raw ?? 0n) + amt, dec: i.tokenAmount.decimals }); }
    }
    const solUsd = await this.solUsd(), rows: any[] = [];
    for (const [mint, h] of [...by].slice(0, 25)) {
      let valueSol: number | null = null;
      if (rows.length < 12) { try { const q = await fetchJupiterQuote({ inputMint: mint, outputMint: 'So11111111111111111111111111111111111111112', amount: h.raw, slippageBps: 50, timeoutMs: 6000 }); valueSol = Number(q.outAmount) / 1e9; } catch { /* no route: balance only */ } }
      rows.push({ mint, decimals: h.dec, balanceRaw: h.raw.toString(), balanceTokens: Number(h.raw) / 10 ** h.dec, valueSol, valueUsd: valueSol != null && solUsd ? valueSol * solUsd : null });
    }
    rows.sort((x, y) => (y.valueSol ?? -1) - (x.valueSol ?? -1));
    const out = { address: c.address, solUsd, tokens: rows, truncated: by.size > 25 }; this.holdCache = { key: c.address, t: Date.now(), out }; return out;
  }
  private histCache?: { key: string; t: number; out: any };
  /** The connected wallet's recent transactions, read from the chain (read-only): what each one did to the SOL balance and to token balances. Cached 30 s. */
  async history(b: any) {
    this.needSession(b); const c = this.need(), me = c.address;
    if (this.histCache && this.histCache.key === me && Date.now() - this.histCache.t < 30_000) return this.histCache.out;
    const sigs: any[] = await c.rpc.call<any>('getSignaturesForAddress', [me, { limit: 20 }]), rows: any[] = [];
    for (const s of sigs) {
      let t: any = null; try { t = await c.rpc.call<any>('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]); } catch { /* skip: shown without details */ }
      const row: any = { signature: s.signature, time: s.blockTime ? s.blockTime * 1000 : null, ok: !s.err, kind: 'Transaction', solDelta: null, feeSol: null, tokens: [] };
      if (t && t.meta) {
        const keys: any[] = t.transaction.message.accountKeys, i = keys.findIndex(k => (k.pubkey ?? k) === me);
        if (i >= 0) row.solDelta = (Number(t.meta.postBalances[i]) - Number(t.meta.preBalances[i])) / 1e9;
        row.feeSol = Number(t.meta.fee) / 1e9;
        const by = new Map<string, { pre: bigint; post: bigint; dec: number }>(), add = (list: any[], k: 'pre' | 'post') => { for (const x of list ?? []) if (x.owner === me) { const e = by.get(x.mint) ?? { pre: 0n, post: 0n, dec: x.uiTokenAmount.decimals }; e[k] += BigInt(x.uiTokenAmount.amount); by.set(x.mint, e); } };
        add(t.meta.preTokenBalances, 'pre'); add(t.meta.postTokenBalances, 'post');
        for (const [mint, e] of by) { const d = e.post - e.pre; if (d !== 0n) row.tokens.push({ mint, delta: Number(d) / 10 ** e.dec }); }
        const sd = row.solDelta ?? 0, td = row.tokens.reduce((a: number, x: any) => a + x.delta, 0);
        row.kind = !row.ok ? 'Failed' : row.tokens.length && td > 0 && sd < 0 ? 'Buy' : row.tokens.length && td < 0 && sd > 0 ? 'Sell' : row.tokens.length ? 'Token transfer' : sd > 0 ? 'SOL received' : sd < 0 ? 'SOL sent' : 'Transaction';
      } else if (s.err) row.kind = 'Failed';
      rows.push(row);
    }
    const out = { address: me, solUsd: await this.solUsd(), rows }; this.histCache = { key: me, t: Date.now(), out }; return out;
  }
  /** Price, decimals and the wallet's balance for the order form. */
  async orderContext(b: any) {
    this.needSession(b); const c = this.need(), mint = String(b?.mint ?? '').trim(); if (!looksLikeMint(mint)) throw bad('that is not a Solana mint address');
    await c.chain.refresh('venues'); await c.chain.addToken(mint); const dec = await this.decimals(mint), px = c.trader.spotE18(mint), bal = await this.tokenBalance(mint);
    return { mint, decimals: dec, priceSol: px === undefined ? null : this.solPerToken(px, dec), solUsd: await this.solUsd(), balanceRaw: bal.toString(), balanceTokens: Number(bal) / 10 ** dec };
  }
  private orderView(o: any, dec: number) {
    return { id: o.id, kind: o.kind, token: o.token, amount: o.amount.toString(), amountTokens: o.kind === 'limit_buy' ? null : Number(o.amount) / 10 ** dec, budgetSol: o.kind === 'limit_buy' ? Number(o.amount) / 1e9 : null,
      triggerPriceSol: o.triggerPriceE18 !== undefined ? this.solPerToken(o.triggerPriceE18, dec) : null, trailPct: o.trailBps ? o.trailBps / 100 : null, status: o.status, reason: o.reason ?? null, attempts: o.attempts, oco: o.ocoGroup ?? null, expiresAt: o.expiresAt,
      triggerUsd: o.usdPrice !== undefined ? Number(o.usdPrice) : null, slippagePct: o.slippageBps / 100, chase: o.chase ? { stepPct: o.chase.stepBps / 100, maxPct: o.chase.maxBps / 100 } : null, maxAttempts: o.maxAttempts };
  }
  // ---- USD triggers come from the SDK (Trader `usd` feed + order.usdPrice): the dollar value is saved on the order itself and the SOL trigger is re-derived from SOL/USD each tick. ----
  /** The SDK's quote/USD feed: SOL/USD with the time it was observed, so the Trader can refuse a stale rate. */
  private usdFeed() { return { quoteUsd: async () => { const v = await this.solUsd(); return v && this.usdCache ? { price: v, at: this.usdCache.t } : null; }, quoteDecimals: 9, tokenDecimals: (mint: string) => this.decimals(mint), maxAgeMs: 120_000 }; }
  /** A dollar price from the page as a plain decimal string (the SDK refuses exponents; JS prints prices below 1e-6 as "1e-7"). Undefined when absent. */
  private usdStr(v: unknown): string | undefined {
    if (v === undefined || v === null || v === '') return undefined; const s = String(v).trim();
    if (/^\d+(\.\d{1,18})?$/.test(s)) return s;   // already plain, at most 18 decimals
    const n = Number(s); if (!(n > 0) || !Number.isFinite(n)) throw bad('enter a dollar price above zero');
    const out = n.toFixed(18).replace(/0+$/, '').replace(/\.$/, ''); if (!/[1-9]/.test(out)) throw bad('that dollar price is too small (below 1e-18)'); return out;   // exponent ("1e-7") or more than 18 decimals
  }
  async listOrders(b: any) {
    this.needSession(b); if (!this.conn) return { orders: [], twaps: [], killed: this.guard.killed, signer: null };
    const c = this.conn, orders = []; for (const o of c.trader.listOrders()) orders.push(this.orderView(o, await this.decimals(o.token).catch(() => 0)));
    const twaps = c.trader.listTwaps().map(t => ({ id: t.id, side: t.side, filled: t.filled, failed: t.failed, skipped: t.skipped, open: t.open, spent: t.spent.toString(), received: t.received.toString(), nextDueAt: t.nextDueAt ?? null, done: t.done, cancelled: t.cancelled, refused: t.refused ?? null }));
    return { orders, twaps, killed: this.guard.killed, signer: this.remote ? 'wallet' : 'key', solUsd: await this.solUsd() };
  }
  /** Place a standing order. It spends nothing now: it trades later, by itself, when its trigger is met, within the same limits as a market trade. */
  /** When the page sends priceUsd (tpUsd / slUsd for a bracket), the trigger is fixed in dollars (see usdFeed); otherwise `price` is SOL per token. */
  async createOrder(b: any) {
    this.needSession(b); const c = this.need(); if (b?.ack !== true) throw bad('placing an order needs ack: true'); if (this.guard.killed) throw new GuardError('the kill switch is on: no new orders', 423);
    const mint = String(b?.mint ?? '').trim(), type = String(b?.type ?? ''); if (!looksLikeMint(mint)) throw bad('that is not a Solana mint address');
    const L = this.guard.limits, slippageBps = Math.round(Number(b?.slippagePct ?? L.maxSlippageBps / 100) * 100); if (!(slippageBps >= 0 && slippageBps <= L.maxSlippageBps)) throw bad(`slippage is above the limit of ${L.maxSlippageBps / 100}%`);
    if ((c.trader.listOrders({ status: 'active' }).length) >= 20) throw bad('too many active orders (20): cancel one first');
    try {
      await c.chain.refresh('venues'); await c.chain.addToken(mint); const dec = await this.decimals(mint), base = { walletId: c.address, token: mint, slippageBps, ttlS: Math.max(60, Math.min(30, Number(b?.ttlDays ?? 7)) * 86_400),
        // slippage chase (opt-in): +1% per failed attempt, capped at the wallet's maximum slippage, so a chase can never pass the limit you set
        ...(b?.chase === true ? (slippageBps < L.maxSlippageBps ? { chase: { stepBps: 100, maxBps: L.maxSlippageBps } } : (() => { throw bad(`chase needs a starting slippage below your maximum of ${L.maxSlippageBps / 100}%`); })()) : {}) };
      const trig = (usd: unknown, sol: unknown, what: string) => { const u = this.usdStr(usd); return u ? { priceUsd: u } : { priceE18: this.priceE18(sol, dec, what) }; };   // dollars when sent, else SOL
      const sellAmount = async () => { const bal = await this.tokenBalance(mint); const raw = b?.pct !== undefined && b?.pct !== '' ? bal * BigInt(Math.round(Number(b.pct) * 100)) / 10_000n : this.units(b?.tokens, dec, 'token amount'); if (raw <= 0n || raw > bal) throw bad(`the wallet holds ${Number(bal) / 10 ** dec} of this token`); return raw; };
      if (type === 'limit_buy') { const lam = this.units(b?.sol, 9, 'amount in SOL'); if (lam > L.maxTradeLamports) throw bad(`${Number(lam) / 1e9} SOL is above the per-trade limit of ${Number(L.maxTradeLamports) / 1e9} SOL`); return { ok: true, order: this.orderView(await c.trader.limitBuy({ ...base, amount: lam, ...trig(b?.priceUsd, b?.price, 'price') }), dec) }; }
      if (type === 'limit_sell') return { ok: true, order: this.orderView(await c.trader.limitSell({ ...base, amount: await sellAmount(), ...trig(b?.priceUsd, b?.price, 'price') }), dec) };
      if (type === 'take_profit') return { ok: true, order: this.orderView(await c.trader.takeProfit({ ...base, amount: await sellAmount(), ...trig(b?.priceUsd, b?.price, 'price') }), dec) };
      if (type === 'stop_loss') return { ok: true, order: this.orderView(await c.trader.stopLoss({ ...base, amount: await sellAmount(), ...trig(b?.priceUsd, b?.price, 'price') }), dec) };
      if (type === 'trailing_stop') { const bps = Math.round(Number(b?.trailPct) * 100); if (!(bps >= 1 && bps <= 9_999)) throw bad('the trail must be between 0.01% and 99.99%'); return { ok: true, order: this.orderView(await c.trader.trailingStop({ ...base, amount: await sellAmount(), trailBps: bps }), dec) }; }
      if (type === 'bracket') { const tpU = this.usdStr(b?.tpUsd), slU = this.usdStr(b?.slUsd);
        const os = await c.trader.bracket({ ...base, amount: await sellAmount(), takeProfitUsd: tpU, stopLossUsd: slU, takeProfitE18: !tpU && b?.tpPrice ? this.priceE18(b.tpPrice, dec, 'take profit price') : undefined, stopLossE18: !slU && b?.slPrice ? this.priceE18(b.slPrice, dec, 'stop loss price') : undefined }); return { ok: true, orders: os.map(o => this.orderView(o, dec)) }; }
      if (type === 'twap') {
        const side = b?.side === 'sell' ? 'sell' : 'buy', slices = Math.round(Number(b?.slices)), intervalS = Math.round(Number(b?.intervalMin) * 60); if (!(slices >= 2 && slices <= 50)) throw bad('slices must be between 2 and 50'); if (!(intervalS >= 10)) throw bad('the interval must be at least 10 seconds');
        const total = side === 'buy' ? this.units(b?.sol, 9, 'total SOL') : await sellAmount();
        if (side === 'buy') { if (total / BigInt(slices) > L.maxTradeLamports) throw bad(`each slice would be above the per-trade limit of ${Number(L.maxTradeLamports) / 1e9} SOL`); if (total > L.dailyCapLamports) throw bad(`the total is above the daily cap of ${Number(L.dailyCapLamports) / 1e9} SOL`); }
        if (side === 'sell') { c.policy.maxPerTx[mint] = BIG; c.policy.dailyLimit[mint] = BIG; }   // see openSellPolicy: sells spend the token, not SOL
        const t = await c.trader.twap({ walletId: c.address, token: mint, side, total, slices, intervalS, slippageBps }); return { ok: true, twap: { id: t.id, side: t.side, open: t.open, filled: t.filled, refused: t.refused ?? null } };
      }
      throw bad('unknown order type');
    } catch (e) { if (e instanceof GuardError) throw e; throw bad(this.redact((e as Error).message), (e as any).status ?? 502); }
  }
  cancelOrder(b: any) { this.needSession(b); const c = this.need(), id = String(b?.id ?? ''); if (b?.kind === 'twap') { c.trader.cancelTwap(id); return { ok: true }; } try { c.trader.cancelOrder(id); } catch (e) { throw bad((e as Error).message, 404); } return { ok: true }; }
  /** Change the trigger price (SOL per token) of an active order. Nothing is signed or spent; the order keeps its tokens and its bracket partner. */
  async editOrder(b: any) {
    this.needSession(b); const c = this.need(), id = String(b?.id ?? ''); const o: any = c.trader.getOrder(id); if (!o) throw bad('no such order', 404);
    const dec = await this.decimals(o.token), usd = this.usdStr(b?.priceUsd); let u: any;   // dollars: fixed in USD from now on; SOL: fixed in SOL again
    try { u = await c.trader.editOrder(id, usd ? { priceUsd: usd } : { priceE18: this.priceE18(b?.price, dec, 'price') }); } catch (e) { throw bad((e as Error).message, (e as any).status === 503 ? 503 : 409); }
    return { ok: true, order: this.orderView(u, dec) };
  }
  private need() { if (!this.conn) throw bad('connect a wallet first', 409); return this.conn; }
  /** Step 1: check limits, find the best route, quote, and simulate a buy. Nothing is signed or sent. */
  async prepare(b: any) {
    this.needSession(b); const c = this.need(), mint = String(b?.mint ?? '').trim(), side = b?.side === 'sell' ? 'sell' : 'buy'; if (!looksLikeMint(mint)) throw bad('that is not a Solana mint address');
    const lamports = side === 'buy' ? BigInt(Math.round(Number(b?.sol) * 1e9)) : 0n; if (side === 'buy' && !(Number(b?.sol) > 0)) throw bad('enter an amount of SOL above zero');
    const slippageBps = Math.round(Number(b?.slippagePct ?? this.guard.limits.maxSlippageBps / 100) * 100), pctBps = side === 'sell' ? Math.round(Number(b?.pct ?? 0) * 100) : undefined;
    try {
      await c.chain.refresh('venues'); await c.chain.addToken(mint); const vs = c.chain.venues().filter(v => this.families.includes(v.family) && (side === 'buy' ? v.supports(NATIVE, mint) : v.supports(mint, NATIVE)));
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
