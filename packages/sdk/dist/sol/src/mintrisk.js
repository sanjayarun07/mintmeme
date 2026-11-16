import { PROGRAMS, base58 } from './tx.js';
export function decodeMint(owner, data, mint) {
    if (owner !== PROGRAMS.token) {
        if (data.length < 82)
            throw new Error(`mint ${mint} is not a recognisable token mint (owner ${owner}, ${data.length} bytes)`);
        return { mint, supply: data.readBigUInt64LE(36), decimals: data[44], token2022: true }; // layout prefix is shared; extensions follow
    }
    if (data.length !== 82)
        throw new Error(`mint ${mint} is ${data.length} bytes, expected 82`);
    if (data[45] !== 1)
        throw new Error(`mint ${mint} is not initialized`);
    return { mint, mintAuthority: data.readUInt32LE(0) === 1 ? base58(data.subarray(4, 36)) : undefined, supply: data.readBigUInt64LE(36), decimals: data[44],
        freezeAuthority: data.readUInt32LE(46) === 1 ? base58(data.subarray(50, 82)) : undefined, token2022: false };
}
export class MintInspector {
    rpc;
    now;
    facts = new Map();
    constructor(rpc, now = () => Math.floor(Date.now() / 1000)) {
        this.rpc = rpc;
        this.now = now;
    }
    async inspect(mint) {
        if (this.facts.has(mint))
            return this.facts.get(mint);
        const r = await this.rpc.call('getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed' }]);
        if (!r?.value)
            throw new Error(`mint ${mint} does not exist`);
        const f = decodeMint(r.value.owner, Buffer.from(r.value.data[0], 'base64'), mint);
        this.facts.set(mint, f);
        return f;
    }
    /** Synchronous check for SnipeConfig.riskCheck. Call `inspect` first (SnipeRunner's `inspect` hook does): an un-inspected mint is quarantined, never assumed safe. */
    riskCheck = (launch, block) => {
        const f = this.facts.get(launch.token), flags = [], notes = [];
        let verdict = 'no-flags';
        const base = { token: launch.token, generatedAt: this.now(), block, disclaimer: 'Mint-account checks only. No sell simulation, no holder-concentration or LP-lock check. Not a safety certification.' };
        if (!f)
            return { ...base, verdict: 'quarantined', flags: ['mint account not inspected yet'], notes };
        if (f.token2022) {
            verdict = 'quarantined';
            flags.push('Token-2022 mint: extensions (transfer fee, hook, permanent delegate) are not understood by this engine');
        }
        if (f.freezeAuthority) {
            verdict = 'blocked';
            flags.push(`freeze authority is set (${f.freezeAuthority}): the issuer can freeze your token account and stop you selling`);
        }
        if (f.mintAuthority) {
            if (verdict === 'no-flags')
                verdict = 'warn';
            flags.push(`mint authority is set (${f.mintAuthority}): supply can be increased at will`);
        }
        if (!flags.length)
            notes.push('mint authority and freeze authority are both revoked');
        flags.push('sell was not simulated and holder concentration / LP lock were not checked');
        if (verdict === 'no-flags')
            verdict = 'warn';
        return { ...base, verdict, flags, notes };
    };
}
