/** TOKEN SAFETY CHECK before a buy. Read-only: the mint account (decoded by the RPC, Token-2022 extensions by name), the largest holders, and whether a sell route exists.
 *  `block` risks mean you could be unable to sell or could lose the tokens; `warn` risks are reasons for care. It is not a safety certification: a token that passes
 *  can still go to zero (a team can sell, liquidity can be pulled), and holder shares can include pools and bonding curves (named where we know them). */
export interface SolRpcLike { call<T = any>(method: string, params?: unknown[]): Promise<T> }
export type RiskLevel = 'block' | 'warn';
export interface SafetyRisk { code: string; level: RiskLevel; message: string }
export interface SafetyReport {
  mint: string; verdict: 'ok' | 'warn' | 'block'; risks: SafetyRisk[];
  facts: { program: 'spl-token' | 'token-2022'; decimals: number; supply: string; mintAuthority: string | null; freezeAuthority: string | null; extensions: string[];
    transferFeeBps: number | null; topHolderPct: number | null; top10Pct: number | null; excludedHolders: string[]; sellRoute: boolean | null; buyImpactPct: number | null };
  checkedAt: string; disclaimer: string;
}
export interface SafetyOptions {
  /** Token accounts that hold supply for trading, not for a person (a bonding curve, a pool vault): left out of the holder shares and listed. */
  liquidityAccounts?: (mint: string) => Promise<string[]> | string[];
  /** Whether the token can be sold back to SOL right now (a pump.fun curve, a Jupiter route). Undefined: not checked. */
  sellRoute?: (mint: string, decimals: number, supply: bigint) => Promise<boolean | undefined>;
  /** Price impact in percent of buying 1 SOL of it now. Undefined: not checked. */
  buyImpactPct?: (mint: string) => Promise<number | undefined>;
  /** Thresholds: a single holder above `topHolderPct` or the top 10 above `top10Pct` (percent of supply) is a warning; impact above `maxImpactPct` too. */
  topHolderPct?: number; top10Pct?: number; maxImpactPct?: number;
  cacheMs?: number; now?: () => number;
}
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
/** Token-2022 extensions that do not affect a holder's ability to sell or keep the token. Anything not listed here or handled below is reported as unknown. */
const HARMLESS = new Set(['metadataPointer', 'tokenMetadata', 'groupPointer', 'tokenGroup', 'groupMemberPointer', 'tokenGroupMember', 'immutableOwner', 'interestBearingConfig', 'scaledUiAmountConfig',
  'confidentialTransferMint', 'confidentialTransferFeeConfig', 'memoTransfer', 'cpiGuard']);

export class TokenSafety {
  private cache = new Map<string, { at: number; r: SafetyReport }>();
  constructor(private rpc: SolRpcLike, private o: SafetyOptions = {}) {}
  async check(mint: string): Promise<SafetyReport> {
    const now = (this.o.now ?? Date.now)(), hit = this.cache.get(mint); if (hit && now - hit.at < (this.o.cacheMs ?? 60_000)) return hit.r;
    const acct: any = await this.rpc.call('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const v = acct?.value; if (!v) throw new Error(`mint ${mint} does not exist`);
    if (v.owner !== TOKEN && v.owner !== TOKEN_2022) throw new Error(`${mint} is not a token mint (owned by ${v.owner})`);
    const info = v.data?.parsed?.info; if (v.data?.parsed?.type !== 'mint' || !info) throw new Error(`${mint} is not a token mint`);
    const risks: SafetyRisk[] = [], add = (code: string, level: RiskLevel, message: string) => risks.push({ code, level, message });
    const exts: { extension: string; state?: any }[] = info.extensions ?? [], names = exts.map(e => e.extension); let feeBps: number | null = null;
    if (info.freezeAuthority) add('freeze_authority', 'block', 'The issuer can freeze your token account, so you might never be able to sell.');
    if (info.mintAuthority) add('mint_authority', 'warn', 'The issuer can create more tokens at will, which dilutes holders.');
    for (const e of exts) {
      const s = e.state ?? {};
      if (e.extension === 'permanentDelegate' && s.delegate) add('permanent_delegate', 'block', 'A permanent delegate can move or burn tokens from any holder\'s account, including yours.');
      else if (e.extension === 'transferHook' && s.programId) add('transfer_hook', 'block', `Every transfer runs another program (${s.programId}), which can block sells.`);
      else if (e.extension === 'nonTransferable') add('non_transferable', 'block', 'The token cannot be transferred, so it cannot be sold.');
      else if (e.extension === 'defaultAccountState' && s.accountState === 'frozen') add('default_frozen', 'block', 'New token accounts start frozen: you could not sell until the issuer unfreezes you.');
      else if (e.extension === 'pausableConfig' || e.extension === 'pausable') add('pausable', 'block', 'The issuer can pause all transfers.');
      else if (e.extension === 'transferFeeConfig') { feeBps = Number(s.newerTransferFee?.transferFeeBasisPoints ?? 0); if (feeBps > 0) add('transfer_fee', feeBps >= 1000 ? 'block' : 'warn', `Every transfer pays a ${feeBps / 100}% fee to the issuer.`); else add('transfer_fee_settable', 'warn', 'A transfer fee is 0% now but the issuer can raise it.'); }
      else if (e.extension === 'mintCloseAuthority' && s.closeAuthority) add('mint_close_authority', 'warn', 'The issuer can close the mint once its supply is zero.');
      else if (!HARMLESS.has(e.extension) && !['permanentDelegate', 'transferHook', 'defaultAccountState', 'mintCloseAuthority'].includes(e.extension)) add(`unknown_extension`, 'warn', `Token-2022 extension "${e.extension}" is not checked by this engine.`);
    }
    // holders: share of supply of the largest accounts, leaving out liquidity accounts we can name (a bonding curve, a pool)
    const supply = BigInt(info.supply), excluded = new Set(await this.o.liquidityAccounts?.(mint) ?? []); let top: number | null = null, top10: number | null = null;
    if (supply > 0n) {
      try {
        const big: any = await this.rpc.call('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
        const amounts = ((big?.value ?? []) as any[]).filter(a => !excluded.has(a.address)).map(a => BigInt(a.amount)).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
        const pct = (x: bigint) => Number(x * 10_000n / supply) / 100;
        top = amounts.length ? pct(amounts[0]) : 0; top10 = pct(amounts.slice(0, 10).reduce((s, x) => s + x, 0n));
        if (top > (this.o.topHolderPct ?? 20)) add('concentrated_holder', 'warn', `One holder has ${top}% of the supply and could crash the price by selling.`);
        if (top10 > (this.o.top10Pct ?? 50)) add('concentrated_top10', 'warn', `The 10 largest holders have ${top10}% of the supply.`);
      } catch { add('holders_unchecked', 'warn', 'The largest holders could not be read.'); }
    }
    let sell: boolean | null = null; try { const s = await this.o.sellRoute?.(mint, Number(info.decimals), supply); sell = s === undefined ? null : s; } catch { sell = null; }
    if (sell === false) add('no_sell_route', 'block', 'No route can sell this token back to SOL right now.');
    let impact: number | null = null; try { const i = await this.o.buyImpactPct?.(mint); impact = i === undefined ? null : i; } catch { impact = null; }
    if (impact !== null && impact > (this.o.maxImpactPct ?? 10)) add('thin_liquidity', 'warn', `Buying 1 SOL of it would move the price by ${impact}%: liquidity is thin.`);
    const verdict = risks.some(r => r.level === 'block') ? 'block' : risks.length ? 'warn' : 'ok';
    const r: SafetyReport = { mint, verdict, risks, facts: { program: v.owner === TOKEN ? 'spl-token' : 'token-2022', decimals: Number(info.decimals), supply: supply.toString(), mintAuthority: info.mintAuthority ?? null,
      freezeAuthority: info.freezeAuthority ?? null, extensions: names, transferFeeBps: feeBps, topHolderPct: top, top10Pct: top10, excludedHolders: [...excluded], sellRoute: sell, buyImpactPct: impact },
      checkedAt: new Date(now).toISOString(), disclaimer: 'Read from the mint, its largest holders and current routes. Not a safety certification: a token that passes can still go to zero.' };
    this.cache.set(mint, { at: now, r }); return r;
  }
}
