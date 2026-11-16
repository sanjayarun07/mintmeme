/** SOLANA ROUTES FOR THE TERMINAL: search any token, read its facts, see which venues can trade it and what 0.01 SOL buys, and SIMULATE a buy. Everything here is read-only:
 *  the RPC client refuses every method that could change state, so these routes cannot send a transaction. Trading on mainnet is a separate, explicit step that is not wired here.
 *  Search results are third-party data (Jupiter, DexScreener) and can be spoofed: the mint address is the only identity, and the response says so. */
import { NATIVE } from '../../packages/core/src/index.ts';
import { SolanaChain, DevSolSigner, searchSolTokens, mintFacts, looksLikeMint } from '../../packages/sol/src/index.ts';
import { GuardedRpc } from '../../packages/live/src/solreadonly.ts';
import { urls } from '../../packages/live/src/config.ts';

const WSOL = 'So11111111111111111111111111111111111111112', LAMPORTS = 10_000_000n;
const rpcFor = () => { const key = process.env.ALCHEMY_API_KEY; if (!key) throw Object.assign(new Error('ALCHEMY_API_KEY is not set (see .env.example)'), { status: 503 }); return { rpc: new GuardedRpc(urls(key).sol), redact: (s: string) => s.split(key).join('***') }; };
const bad = (m: string) => Object.assign(new Error(m), { status: 400 });
const safe = async <T>(f: () => Promise<T>) => { const { redact } = rpcFor(); try { return await f(); } catch (e) { throw Object.assign(new Error(redact((e as Error).message)), { status: (e as any).status ?? 502 }); } };

export async function solSearch(body: any) {
  const q = String(body?.q ?? '').trim(); if (!q || q.length > 80) throw bad('type a name, a symbol or a mint address (up to 80 characters)');
  return safe(async () => { const { hits, errors } = await searchSolTokens(q, { limit: 10 }); return { query: q, hits, sourceProblems: errors, notice: 'Search results are third-party data and can be spoofed. The mint address is the only identity: check it before you trade.' }; });
}

export async function solToken(body: any) {
  const mint = String(body?.mint ?? '').trim(); if (!looksLikeMint(mint)) throw bad('that is not a Solana mint address');
  return safe(async () => {
    const { rpc } = rpcFor(), facts = await mintFacts(rpc, mint), chain = new SolanaChain({ id: 'sol-main', wsol: WSOL, pools: [], pump: { mints: [] }, jupiter: { pairs: [] } }, rpc, new DevSolSigner());
    const r = await chain.addToken(mint), venues = chain.venues().filter(v => v.supports(NATIVE, mint)).map(v => { const q = v.quote(NATIVE, mint, LAMPORTS); return { venue: v.id, spendLamports: LAMPORTS.toString(), amountOut: q.amountOut.toString(), priceImpactPct: q.priceImpactBps / 100 }; });
    return { mint, facts, routes: { pump: r.pump, jupiter: r.jupiter }, notes: r.notes, venues, tradable: venues.length > 0 };
  });
}

/** Simulate (never send) a 0.01 SOL buy as a public wallet address. A wallet that holds no SOL will show an insufficient-funds result: that is expected. */
export async function solSimulate(body: any) {
  const mint = String(body?.mint ?? '').trim(), wallet = String(body?.wallet ?? '').trim(); if (!looksLikeMint(mint) || !looksLikeMint(wallet)) throw bad('mint and wallet must both be Solana addresses');
  return safe(async () => {
    const { rpc } = rpcFor(), chain = new SolanaChain({ id: 'sol-main', wsol: WSOL, pools: [], pump: { mints: [] }, jupiter: { pairs: [] } }, rpc, new DevSolSigner()); await chain.addToken(mint);
    const v = chain.venues().find(x => x.supports(NATIVE, mint)); if (!v) throw bad('no venue can trade this token');
    const tx: any = { kind: 'swap', wallet, venue: v.id, tokenIn: NATIVE, tokenOut: mint, amountIn: LAMPORTS, minOut: 0n, platformFeeBps: 0, nonce: 0, hash: '', deadline: 0 };
    const b = await chain.simulate(tx); let reason = b.receipt.reason?.slice(0, 300) ?? null;
    if (reason && reason.includes('AccountNotFound')) reason += ' (This wallet has never received SOL, so it does not exist on-chain yet. Send it a little SOL, then simulate again. This is expected for a new wallet.)';
    return { venue: v.id, status: b.receipt.status, reason, sent: false, notice: 'Simulation only. Nothing was signed or sent.' };
  });
}
