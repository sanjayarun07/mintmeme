/** Balance allocation: strategies must reserve before spending; prevents two strategies using the same balance. */
export declare class Reservations {
    private balanceOf;
    private held;
    constructor(balanceOf: (wallet: string, token: string) => bigint);
    snapshot(): [string, [string, string][]][];
    load(s: [string, [string, string][]][]): void;
    reservedTotal(w: string, t: string): bigint;
    available(w: string, t: string): bigint;
    reserve(owner: string, w: string, t: string, amt: bigint): void;
    release(owner: string, w: string, t: string): void;
    held_(owner: string, w: string, t: string): bigint;
}
