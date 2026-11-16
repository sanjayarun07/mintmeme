/** Persisted step machine; bridge+swap is NOT atomic, so every step is recorded and balances stay recoverable. */
export function startBridge(id, amount, minReceived, destAddr, authorizedDests) {
    if (!authorizedDests.includes(destAddr))
        throw new Error('destination address not explicitly authorized');
    return { id, amount, minReceived, destAddr, destAuthorized: true, intermediate: 'source',
        steps: ['source_tx', 'in_transit', 'destination_confirm', 'swap'].map(name => ({ name, state: 'pending' })) };
}
export function resume(op, p, doSwap) {
    for (const s of op.steps) {
        if (s.state === 'done')
            continue;
        if (s.state === 'failed')
            return op; // stop; funds remain at op.intermediate; caller decides (retry/withdraw)
        if (s.name === 'source_tx') {
            if (p.send(op.id, op.amount) === 'fail') {
                s.state = 'failed';
                s.note = 'source send failed; funds still on source';
                return op;
            }
            s.state = 'done';
            op.intermediate = 'bridge';
        }
        else if (s.name === 'in_transit') {
            const st = p.status(op.id);
            if (st === 'in_transit')
                return op;
            if (st === 'lost') {
                s.state = 'failed';
                s.note = 'provider reports lost';
                return op;
            }
            s.state = 'done';
        }
        else if (s.name === 'destination_confirm') {
            s.state = 'done';
            op.intermediate = 'destination';
        }
        else if (s.name === 'swap') {
            if (!doSwap()) {
                s.state = 'failed';
                s.note = 'dest swap failed; bridged asset held on destination';
                return op;
            }
            s.state = 'done';
        }
    }
    return op;
}
/** Batch distribute with per-item state so a partial failure can be resumed without double-sending. */
export function distribute(items, send, reserve, balance) {
    let bal = balance - reserve;
    for (const it of items) {
        if (it.done)
            continue;
        if (bal < it.amount)
            break;
        if (send(it.to, it.amount)) {
            it.done = true;
            bal -= it.amount;
        }
        else
            break;
    }
    return items;
}
/** Plan a /disperse: split `pctBps` (10_000 = 100%) of `balance` EQUALLY across recipients, after keeping `reserve` (gas) back.
 *  Source: https://docs.maestrobots.com/sniper/funds-management.md ("splitting a chosen percentage of a token balance equally"). Integer division: the remainder stays in the source. */
export function planDisperse(balance, pctBps, to, reserve = 0n) {
    if (!Number.isInteger(pctBps) || pctBps <= 0 || pctBps > 10_000)
        throw new Error('percentage must be 0.01%..100%');
    if (to.length === 0)
        throw new Error('no recipients');
    if (new Set(to).size !== to.length)
        throw new Error('duplicate recipient');
    const spendable = balance > reserve ? balance - reserve : 0n;
    const each = spendable * BigInt(pctBps) / 10000n / BigInt(to.length);
    return to.map(t => ({ to: t, amount: each }));
}
/** /collect sweep: selected source wallets -> one receiver, native and tokens. https://docs.maestrobots.com/sniper/funds-management.md
 *  Resumable: each item carries `done`; call again with the same array after a failure and finished items are never sent twice. Stops at the first failed send (state stays consistent).
 *  Native: balance minus `reserveNative`. Tokens: the whole raw balance. A source equal to the receiver, or with nothing to send, is marked done with a note. */
export function collect(items, d) {
    if (!d.wallets.includes(d.receiver) && !d.allowExternalReceiver)
        throw new Error('receiver is not one of your wallets (set allowExternalReceiver to send elsewhere)');
    const seen = new Set();
    for (const it of items) {
        const k = `${it.from}|${it.token}`;
        if (seen.has(k))
            throw new Error(`duplicate sweep item ${k}`);
        seen.add(k);
        if (!d.wallets.includes(it.from))
            throw new Error(`source ${it.from} is not one of your wallets`);
    }
    for (const it of items) {
        if (it.done)
            continue;
        if (it.from === d.receiver) {
            it.done = true;
            it.sent = 0n;
            it.note = 'source is the receiver';
            continue;
        }
        const bal = d.balanceOf(it.from, it.token), spendable = it.token === d.nativeToken ? (bal > d.reserveNative ? bal - d.reserveNative : 0n) : bal;
        if (spendable <= 0n) {
            it.done = true;
            it.sent = 0n;
            it.note = it.token === d.nativeToken ? 'balance does not cover the gas reserve' : 'nothing to send';
            continue;
        }
        const cap = d.cap?.(it.from, it.token);
        const amt = cap !== undefined && cap < spendable ? cap : spendable;
        if (!d.send(it.from, d.receiver, it.token, amt)) {
            it.note = 'send failed; resume to retry';
            break;
        }
        it.done = true;
        it.sent = amt;
        it.note = amt < spendable ? 'capped' : undefined;
    }
    return items;
}
