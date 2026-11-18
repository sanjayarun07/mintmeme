import { stockByMint } from './xstocks.js';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
/** Token-2022 extensions that do not affect a holder's ability to sell or keep the token. Anything not listed here or handled below is reported as unknown. */
const HARMLESS = new Set(['metadataPointer', 'tokenMetadata', 'groupPointer', 'tokenGroup', 'groupMemberPointer', 'tokenGroupMember', 'immutableOwner', 'interestBearingConfig', 'scaledUiAmountConfig',
    'confidentialTransferMint', 'confidentialTransferFeeConfig', 'memoTransfer', 'cpiGuard']);
export class TokenSafety {
    rpc;
    o;
    cache = new Map();
    constructor(rpc, o = {}) {
        this.rpc = rpc;
        this.o = o;
    }
    async check(mint) {
        const now = (this.o.now ?? Date.now)(), hit = this.cache.get(mint);
        if (hit && now - hit.at < (this.o.cacheMs ?? 60_000))
            return hit.r;
        const acct = await this.rpc.call('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
        const v = acct?.value;
        if (!v)
            throw new Error(`mint ${mint} does not exist`);
        if (v.owner !== TOKEN && v.owner !== TOKEN_2022)
            throw new Error(`${mint} is not a token mint (owned by ${v.owner})`);
        const info = v.data?.parsed?.info;
        if (v.data?.parsed?.type !== 'mint' || !info)
            throw new Error(`${mint} is not a token mint`);
        const risks = [], add = (code, level, message) => risks.push({ code, level, message });
        const exts = info.extensions ?? [], names = exts.map(e => e.extension);
        let feeBps = null;
        // a known issued asset (xStock) whose authorities still equal the issuer's pinned keys: its freeze, pause and permanent delegate are the issuer's legal controls, reported as warnings
        const known = this.o.issuedAssets ? this.o.issuedAssets.find(a => a.mint === mint) : stockByMint(mint), st = (n) => exts.find(e => e.extension === n)?.state ?? {};
        const pinned = !!known && v.owner === TOKEN_2022 && info.freezeAuthority === known.keys.freezeAuthority && (st('permanentDelegate').delegate ?? null) === known.keys.permanentDelegate
            && (st('pausableConfig').authority ?? st('pausable').authority) === known.keys.pauseAuthority;
        if (known && !pinned)
            add('issuer_keys_changed', 'block', `This mint is listed as ${known.symbol} (${known.issuer}) but its freeze, pause or delegate keys are not the issuer's pinned keys: checked like any other token.`);
        const issuer = pinned ? known.issuer : '';
        if (info.freezeAuthority) {
            if (pinned)
                add('issuer_freeze', 'warn', `${issuer} can freeze any holder's account (for sanctions or court orders): a frozen account cannot sell.`);
            else
                add('freeze_authority', 'block', 'The issuer can freeze your token account, so you might never be able to sell.');
        }
        if (info.mintAuthority)
            add('mint_authority', 'warn', pinned ? `${issuer} mints and burns this token against the shares it holds.` : 'The issuer can create more tokens at will, which dilutes holders.');
        for (const e of exts) {
            const s = e.state ?? {};
            if (e.extension === 'permanentDelegate' && s.delegate) {
                if (pinned)
                    add('issuer_delegate', 'warn', `${issuer} keeps a permanent delegate that can move or burn tokens from any account (legal seizure, corporate actions).`);
                else
                    add('permanent_delegate', 'block', 'A permanent delegate can move or burn tokens from any holder\'s account, including yours.');
            }
            else if (e.extension === 'transferHook' && s.programId)
                add('transfer_hook', 'block', `Every transfer runs another program (${s.programId}), which can block sells.`);
            else if (e.extension === 'nonTransferable')
                add('non_transferable', 'block', 'The token cannot be transferred, so it cannot be sold.');
            else if (e.extension === 'defaultAccountState' && s.accountState === 'frozen')
                add('default_frozen', 'block', 'New token accounts start frozen: you could not sell until the issuer unfreezes you.');
            else if ((e.extension === 'pausableConfig' || e.extension === 'pausable') && s.paused === true)
                add('paused', 'block', 'Transfers of this token are paused by the issuer right now: it cannot be bought or sold.');
            else if (e.extension === 'pausableConfig' || e.extension === 'pausable') {
                if (pinned)
                    add('issuer_pause', 'warn', `${issuer} can pause all transfers (it does so around corporate actions and market closures).`);
                else
                    add('pausable', 'block', 'The issuer can pause all transfers.');
            }
            else if (e.extension === 'transferFeeConfig') {
                feeBps = Number(s.newerTransferFee?.transferFeeBasisPoints ?? 0);
                if (feeBps > 0)
                    add('transfer_fee', feeBps >= 1000 ? 'block' : 'warn', `Every transfer pays a ${feeBps / 100}% fee to the issuer.`);
                else
                    add('transfer_fee_settable', 'warn', 'A transfer fee is 0% now but the issuer can raise it.');
            }
            else if (e.extension === 'mintCloseAuthority' && s.closeAuthority)
                add('mint_close_authority', 'warn', 'The issuer can close the mint once its supply is zero.');
            else if (!HARMLESS.has(e.extension) && !['permanentDelegate', 'transferHook', 'defaultAccountState', 'mintCloseAuthority'].includes(e.extension))
                add(`unknown_extension`, 'warn', `Token-2022 extension "${e.extension}" is not checked by this engine.`);
        }
        // holders: share of supply of the largest accounts, leaving out liquidity accounts we can name (a bonding curve, a pool)
        const supply = BigInt(info.supply), excluded = new Set(await this.o.liquidityAccounts?.(mint) ?? []);
        let top = null, top10 = null;
        if (supply > 0n) {
            try {
                const big = await this.rpc.call('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
                const amounts = (big?.value ?? []).filter(a => !excluded.has(a.address)).map(a => BigInt(a.amount)).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
                const pct = (x) => Number(x * 10000n / supply) / 100;
                top = amounts.length ? pct(amounts[0]) : 0;
                top10 = pct(amounts.slice(0, 10).reduce((s, x) => s + x, 0n));
                if (top > (this.o.topHolderPct ?? 20))
                    add('concentrated_holder', 'warn', `One holder has ${top}% of the supply and could crash the price by selling.`);
                if (top10 > (this.o.top10Pct ?? 50))
                    add('concentrated_top10', 'warn', `The 10 largest holders have ${top10}% of the supply.`);
            }
            catch {
                add('holders_unchecked', 'warn', 'The largest holders could not be read.');
            }
        }
        let sell = null;
        try {
            const s = await this.o.sellRoute?.(mint, Number(info.decimals), supply);
            sell = s === undefined ? null : s;
        }
        catch {
            sell = null;
        }
        if (sell === false)
            add('no_sell_route', 'block', 'No route can sell this token back to SOL right now.');
        let impact = null;
        try {
            const i = await this.o.buyImpactPct?.(mint);
            impact = i === undefined ? null : i;
        }
        catch {
            impact = null;
        }
        if (impact !== null && impact > (this.o.maxImpactPct ?? 10))
            add('thin_liquidity', 'warn', `Buying 1 SOL of it would move the price by ${impact}%: liquidity is thin.`);
        const verdict = risks.some(r => r.level === 'block') ? 'block' : risks.length ? 'warn' : 'ok';
        const r = { mint, verdict, risks, facts: { program: v.owner === TOKEN ? 'spl-token' : 'token-2022', decimals: Number(info.decimals), supply: supply.toString(), mintAuthority: info.mintAuthority ?? null,
                freezeAuthority: info.freezeAuthority ?? null, extensions: names, transferFeeBps: feeBps, topHolderPct: top, top10Pct: top10, excludedHolders: [...excluded], sellRoute: sell, buyImpactPct: impact,
                issuedAsset: pinned ? { symbol: known.symbol, issuer: known.issuer } : null },
            checkedAt: new Date(now).toISOString(), disclaimer: 'Read from the mint, its largest holders and current routes. Not a safety certification: a token that passes can still go to zero.' };
        this.cache.set(mint, { at: now, r });
        return r;
    }
}
