export interface Candidate {
    family: 'evm' | 'solana' | 'ton' | 'tron';
    address: string;
}
/** Pure extraction of CANDIDATES from untrusted text. Output is data only: cannot change limits, wallets or config. */
export declare function extract(text: string): Candidate[];
export declare class SignalFilter {
    private maxAgeS;
    private validate;
    private seen;
    constructor(maxAgeS: number, validate: (c: Candidate) => {
        chain: string;
    } | undefined);
    /** Returns a trade PREVIEW candidate or a rejection reason. Never trades by itself. */
    process(channel: string, text: string, msgTs: number, now: number): {
        chain: string;
        address: string;
    }[] | string;
}
