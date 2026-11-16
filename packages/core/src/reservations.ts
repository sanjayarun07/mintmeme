/** Balance allocation: strategies must reserve before spending; prevents two strategies using the same balance. */
export class Reservations {
  private held = new Map<string, Map<string, bigint>>(); // `${wallet}:${token}` -> owner -> amount
  constructor(private balanceOf: (wallet: string, token: string) => bigint) {}
  snapshot() { return [...this.held].map(([k, m]) => [k, [...m].map(([o, a]) => [o, a.toString()])] as [string, [string, string][]]); }
  load(s: [string, [string, string][]][]) { this.held = new Map(s.map(([k, m]) => [k, new Map(m.map(([o, a]) => [o, BigInt(a)]))])); }
  reservedTotal(w: string, t: string) { let s = 0n; for (const v of this.held.get(`${w}:${t}`)?.values() ?? []) s += v; return s; }
  available(w: string, t: string) { return this.balanceOf(w, t) - this.reservedTotal(w, t); }
  reserve(owner: string, w: string, t: string, amt: bigint) {
    if (amt <= 0n) throw new Error('reserve amount must be positive');
    if (this.available(w, t) < amt) throw new Error(`insufficient unreserved balance for ${owner}`);
    const m = this.held.get(`${w}:${t}`) ?? new Map(); m.set(owner, (m.get(owner) ?? 0n) + amt); this.held.set(`${w}:${t}`, m);
  }
  release(owner: string, w: string, t: string) { this.held.get(`${w}:${t}`)?.delete(owner); }
  held_(owner: string, w: string, t: string) { return this.held.get(`${w}:${t}`)?.get(owner) ?? 0n; }
}
