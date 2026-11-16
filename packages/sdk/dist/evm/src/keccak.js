/** Keccak-f[1600] sponge (Ethereum keccak256, pad 0x01). `pad` 0x06 gives NIST SHA3 (used only to cross-check against node:crypto). */
const M = (1n << 64n) - 1n;
const RC = [];
const ROT = new Array(25).fill(0);
(() => {
    // round constants via LFSR
    let r = 1;
    for (let i = 0; i < 24; i++) {
        let c = 0n;
        for (let j = 0; j < 7; j++) {
            if (r & 1)
                c |= 1n << BigInt((1 << j) - 1);
            r = r & 0x80 ? ((r << 1) ^ 0x71) & 0xff : (r << 1) & 0xff;
        }
        RC.push(c);
    }
    // rotation offsets
    let x = 1, y = 0;
    for (let t = 0; t < 24; t++) {
        ROT[x + 5 * y] = (((t + 1) * (t + 2)) / 2) % 64;
        [x, y] = [y, (2 * x + 3 * y) % 5];
    }
})();
const rotl = (v, n) => n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M;
function permute(s) {
    for (let round = 0; round < 24; round++) {
        const C = new Array(5), B = new Array(25);
        for (let x = 0; x < 5; x++)
            C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
        for (let x = 0; x < 5; x++) {
            const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
            for (let y = 0; y < 25; y += 5)
                s[x + y] ^= D;
        }
        for (let x = 0; x < 5; x++)
            for (let y = 0; y < 5; y++)
                B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
        for (let x = 0; x < 5; x++)
            for (let y = 0; y < 5; y++)
                s[x + 5 * y] = B[x + 5 * y] ^ (~B[(x + 1) % 5 + 5 * y] & M & B[(x + 2) % 5 + 5 * y]);
        s[0] ^= RC[round];
    }
}
export function sponge256(data, pad) {
    const rate = 136;
    const s = new Array(25).fill(0n);
    const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate);
    padded.set(data);
    padded[data.length] ^= pad;
    padded[padded.length - 1] ^= 0x80;
    for (let off = 0; off < padded.length; off += rate) {
        for (let i = 0; i < rate / 8; i++) {
            let lane = 0n;
            for (let b = 7; b >= 0; b--)
                lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
            s[i] ^= lane;
        }
        permute(s);
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++)
        out[i] = Number((s[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn);
    return out;
}
export const keccak256 = (data) => sponge256(data, 0x01);
export function hexToBytes(h) {
    const s = h.startsWith('0x') || h.startsWith('0X') ? h.slice(2) : h;
    if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s))
        throw new Error(`invalid hex: ${h}`);
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++)
        out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
    return out;
}
export const bytesToHex = (b) => '0x' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
export const keccakHex = (data) => bytesToHex(keccak256(typeof data === 'string' ? new TextEncoder().encode(data) : data));
/** 4-byte selector, e.g. selector('transfer(address,uint256)') = 0xa9059cbb */
export const selector = (sig) => keccakHex(sig).slice(0, 10);
