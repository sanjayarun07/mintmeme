import { NATIVE } from './types.js';
const DISCLAIMER = 'Heuristic report at the stated block. A passing simulation is NOT a safety certification; state can change at any time.';
/** Simulation-backed risk report: buy then sell dry-runs through the chain; taxes measured from balance deltas. */
export function analyze(chain, f, probe) {
    const flags = [], notes = [];
    let verdict = 'no-flags';
    let buyTax, sellTax;
    const mk = (tokenIn, tokenOut, amountIn) => ({ hash: 'probe', wallet: probe.wallet, nonce: chain.confirmedNonce(probe.wallet), venue: probe.venue,
        tokenIn, tokenOut, amountIn, minOut: 0n, deadline: chain.time + 60, platformFeeBps: 0 });
    const venue = chain.state.venues.get(probe.venue);
    const buy = chain.simulate(mk(probe.quoteToken, f.address, probe.amount));
    if (buy.receipt.status === 'reverted') {
        flags.push(`buy simulation reverts: ${buy.receipt.reason}`);
        verdict = 'blocked';
    }
    else {
        const got = buy.receipt.deltas[f.address] ?? 0n;
        const ideal = venue ? venue.quote(probe.quoteToken, f.address, probe.amount).amountOut : got;
        buyTax = ideal === 0n ? 0 : Number((ideal - got) * 10000n / ideal);
        // sell back the amount we would hold (simulated on a funded clone via direct pool math is out of scope for sim state: fund then simulate)
        chain.credit(probe.wallet, f.address, got);
        const sell = chain.simulate(mk(f.address, probe.quoteToken, got));
        chain.state.bal.set(`${probe.wallet}:${f.address}`, chain.balance(probe.wallet, f.address) - got);
        if (sell.receipt.status === 'reverted') {
            flags.push(`sell simulation reverts: ${sell.receipt.reason} (possible honeypot)`);
            verdict = 'blocked';
        }
        else {
            const sold = venue ? venue.quote(f.address, probe.quoteToken, got).amountOut : 0n;
            const recv = (sell.receipt.deltas[probe.quoteToken] ?? 0n) + (probe.quoteToken === NATIVE ? sell.receipt.network : 0n);
            sellTax = sold === 0n ? 0 : Number((sold - recv) * 10000n / sold);
            if (buyTax > 500 || sellTax > 500) {
                flags.push(`high transfer tax (buy ${buyTax}bps, sell ${sellTax}bps)`);
                verdict = 'warn';
            }
            else if (buyTax > 0 || sellTax > 0)
                notes.push('taxed token: only tradeable through tax-aware adapters with balance-delta accounting');
        }
    }
    if (f.rebasing) {
        flags.push('rebasing/unusual balance behavior');
        if (verdict !== 'blocked')
            verdict = 'quarantined';
    }
    if (f.knownMalicious) {
        flags.push('matches known-malicious indicator');
        verdict = 'blocked';
    }
    const w = (c, m) => { if (c) {
        flags.push(m);
        if (verdict === 'no-flags')
            verdict = 'warn';
    } };
    w(f.mintAuthority, 'mint authority active');
    w(f.freezeAuthority, 'freeze authority active');
    w(f.owner, 'privileged owner present');
    w(f.upgradeable, 'upgradeable');
    w(f.pausable, 'pausable');
    w(f.blacklist, 'blacklist function');
    w((f.topHoldersPct ?? 0) > 50, 'top holders >50% of supply');
    w((f.lpTopPct ?? 0) > 80, 'liquidity concentrated in one position');
    if (f.lpLockedPct === null || f.lpLockedPct === undefined)
        notes.push('LP lock status unverifiable');
    else
        w(f.lpLockedPct < 50, 'LP mostly unlocked');
    return { token: f.address, generatedAt: chain.time, block: chain.block, verdict, flags, buyTaxBps: buyTax, sellTaxBps: sellTax, notes, disclaimer: DISCLAIMER };
}
