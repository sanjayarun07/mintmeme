/** Balance allocation: strategies must reserve before spending; prevents two strategies using the same balance. */
export class Reservations {
    balanceOf;
    held = new Map(); // `${wallet}:${token}` -> owner -> amount
    constructor(balanceOf) {
        this.balanceOf = balanceOf;
    }
    snapshot() { return [...this.held].map(([k, m]) => [k, [...m].map(([o, a]) => [o, a.toString()])]); }
    load(s) { this.held = new Map(s.map(([k, m]) => [k, new Map(m.map(([o, a]) => [o, BigInt(a)]))])); }
    reservedTotal(w, t) { let s = 0n; for (const v of this.held.get(`${w}:${t}`)?.values() ?? [])
        s += v; return s; }
    available(w, t) { return this.balanceOf(w, t) - this.reservedTotal(w, t); }
    reserve(owner, w, t, amt) {
        if (amt <= 0n)
            throw new Error('reserve amount must be positive');
        if (this.available(w, t) < amt)
            throw new Error(`insufficient unreserved balance for ${owner}`);
        const m = this.held.get(`${w}:${t}`) ?? new Map();
        m.set(owner, (m.get(owner) ?? 0n) + amt);
        this.held.set(`${w}:${t}`, m);
    }
    release(owner, w, t) { this.held.get(`${w}:${t}`)?.delete(owner); }
    held_(owner, w, t) { return this.held.get(`${w}:${t}`)?.get(owner) ?? 0n; }
}
