/** Find any Solana token by name, symbol or mint address. READ-ONLY third-party data: Jupiter's token search and DexScreener's pair search. Both are unverified, can include spoofed tokens (a fake "BONK" with its own mint),
 *  and say nothing about whether a token is safe. The mint address is the only identity: always show it, and check the on-chain facts (`mintFacts`) before trading. Nothing here sends a transaction. */
import { b58decode } from './tx.js';
export const JUPITER_SEARCH_URL = 'https://lite-api.jup.ag/tokens/v2/search', DEXSCREENER_SEARCH_URL = 'https://api.dexscreener.com/latest/dex/search', DEXSCREENER_TOKEN_URL = 'https://api.dexscreener.com/tokens/v1/solana';
const WSOL = 'So11111111111111111111111111111111111111112';
export const looksLikeMint = (s) => { try {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && b58decode(s).length === 32;
}
catch {
    return false;
} };
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && x !== '' && Number.isFinite(Number(x)) ? Number(x) : undefined);
const str = (x, max = 64) => (typeof x === 'string' ? x.replace(/[\u0000-\u001f<>]/g, '').slice(0, max) : '');
async function getJson(fetchFn, url, timeoutMs) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const r = await fetchFn(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
        if (!r.ok)
            throw new Error(`HTTP ${r.status}`);
        return await r.json();
    }
    finally {
        clearTimeout(t);
    }
}
/** Search by free text or by mint. Results are merged by mint and ordered by liquidity. A source that fails is skipped and named in `errors`. */
export async function searchSolTokens(query, o = {}) {
    const q = query.trim(), f = o.fetchFn ?? fetch, tm = o.timeoutMs ?? 8000, errors = [], by = new Map();
    if (!q)
        return { hits: [], errors };
    const add = (h, source) => {
        if (!looksLikeMint(h.mint))
            return;
        const cur = by.get(h.mint) ?? { mint: h.mint, symbol: '', name: '', pairs: [], sources: [], pumpLike: h.mint.endsWith('pump') };
        by.set(h.mint, { ...cur, ...Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))), pairs: [...cur.pairs, ...(h.pairs ?? [])], sources: cur.sources.includes(source) ? cur.sources : [...cur.sources, source] });
        const m = by.get(h.mint);
        m.liquidityUsd = Math.max(cur.liquidityUsd ?? 0, h.liquidityUsd ?? 0) || undefined; // Jupiter reports a token-wide figure, DexScreener a per-pair one: keep the larger, never overwrite it with a smaller one
    };
    const jobs = [];
    jobs.push((async () => {
        try {
            const j = await getJson(f, `${JUPITER_SEARCH_URL}?query=${encodeURIComponent(q)}`, tm);
            for (const t of Array.isArray(j) ? j : [])
                add({ mint: str(t.id, 44), symbol: str(t.symbol, 24), name: str(t.name), decimals: num(t.decimals), tokenProgram: str(t.tokenProgram, 44), priceUsd: num(t.usdPrice), liquidityUsd: num(t.liquidity), marketCapUsd: num(t.mcap), holders: num(t.holderCount), volume24hUsd: num((t.stats24h?.buyVolume ?? 0) + (t.stats24h?.sellVolume ?? 0)) }, 'jupiter');
        }
        catch (e) {
            errors.push(`jupiter search: ${e.message}`);
        }
    })());
    jobs.push((async () => {
        try {
            const j = looksLikeMint(q) ? await getJson(f, `${DEXSCREENER_TOKEN_URL}/${q}`, tm) : (await getJson(f, `${DEXSCREENER_SEARCH_URL}?q=${encodeURIComponent(q)}`, tm)).pairs;
            for (const p of Array.isArray(j) ? j : []) {
                if (p.chainId !== 'solana')
                    continue;
                const base = p.baseToken, quote = p.quoteToken;
                const tok = base?.address === WSOL ? quote : base;
                if (!tok?.address)
                    continue;
                add({ mint: str(tok.address, 44), symbol: str(tok.symbol, 24), name: str(tok.name), priceUsd: tok.address === base?.address ? num(p.priceUsd) : undefined, marketCapUsd: num(p.marketCap ?? p.fdv), volume24hUsd: num(p.volume?.h24), pairs: [{ dex: str(p.dexId, 24), pair: str(p.pairAddress, 44), liquidityUsd: num(p.liquidity?.usd) }], liquidityUsd: num(p.liquidity?.usd) }, 'dexscreener');
            }
        }
        catch (e) {
            errors.push(`dexscreener search: ${e.message}`);
        }
    })());
    await Promise.all(jobs);
    for (const h of by.values()) {
        if (h.pairs.length)
            h.liquidityUsd = Math.max(h.liquidityUsd ?? 0, ...h.pairs.map(p => p.liquidityUsd ?? 0));
    }
    const hits = [...by.values()].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)).slice(0, o.limit ?? 20);
    return { hits, errors };
}
/** On-chain facts for a mint, read with getAccountInfo (SPL and Token-2022 layouts: supply at 36, decimals at 44, authorities as optional keys). Warnings are plain statements, not a safety verdict. */
export async function mintFacts(rpc, mint) {
    const r = await rpc.call('getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed' }]);
    const warnings = [];
    if (!r?.value)
        return { mint, exists: false, warnings: ['no account with this address exists on this cluster'] };
    const d = Buffer.from(r.value.data[0], 'base64'), owner = String(r.value.owner), classic = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', t22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    if ((owner !== classic && owner !== t22) || d.length < 82)
        return { mint, exists: true, tokenProgram: owner, warnings: ['this address is not a token mint'] };
    const opt = (off) => (d.readUInt32LE(off) === 1 ? (b58 => b58)(Buffer.from(d.subarray(off + 4, off + 36)).toString('hex')) : null);
    const mintAuth = opt(0), freeze = opt(46);
    if (mintAuth)
        warnings.push('the mint authority is still set: more of this token can be created');
    if (freeze)
        warnings.push('a freeze authority is set: your balance can be frozen');
    if (owner === t22 && d.length > 82)
        warnings.push('Token-2022 with extensions: transfer fees, hooks or other special behaviour are possible and are not decoded here');
    return { mint, exists: true, tokenProgram: owner, decimals: d[44], supply: d.readBigUInt64LE(36), mintAuthority: mintAuth, freezeAuthority: freeze, warnings };
}
