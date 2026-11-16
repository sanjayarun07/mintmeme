import { bytesToHex, hexToBytes, selector } from './keccak.js';
const WORD = 32;
const isArr = (t) => t.endsWith('[]');
export function isAddress(a) { return /^0x[0-9a-fA-F]{40}$/.test(a); }
export const normAddr = (a) => { if (!isAddress(a))
    throw new Error(`invalid address: ${a}`); return a.toLowerCase(); };
function word(n) {
    if (n < 0n || n >= 1n << 256n)
        throw new Error('uint256 out of range');
    return n.toString(16).padStart(64, '0');
}
function encStatic(t, v) {
    if (t === 'address')
        return normAddr(v).slice(2).padStart(64, '0');
    if (t === 'bool')
        return word(v ? 1n : 0n);
    if (t.startsWith('uint')) {
        const bits = t === 'uint' ? 256 : Number(t.slice(4));
        const n = BigInt(v);
        if (n < 0n || n >= 1n << BigInt(bits))
            throw new Error(`${t} out of range`);
        return word(n);
    }
    if (t === 'bytes32') {
        const h = v.replace(/^0x/, '');
        if (h.length !== 64)
            throw new Error('bytes32 length');
        return h.toLowerCase();
    }
    throw new Error(`unsupported type ${t}`);
}
export function encodeParams(types, values) {
    if (types.length !== values.length)
        throw new Error('arity mismatch');
    let head = '', tail = '';
    const headSize = types.length * WORD;
    types.forEach((t, i) => {
        if (isArr(t)) {
            const el = t.slice(0, -2), arr = values[i];
            head += word(BigInt(headSize + tail.length / 2));
            tail += word(BigInt(arr.length)) + arr.map(x => encStatic(el, x)).join('');
        }
        else
            head += encStatic(t, values[i]);
    });
    return head + tail;
}
export function encodeCall(sig, values) {
    const inner = sig.slice(sig.indexOf('(') + 1, sig.lastIndexOf(')'));
    const types = inner === '' ? [] : inner.split(',');
    return selector(sig) + encodeParams(types, values);
}
export function decodeParams(types, data) {
    const b = typeof data === 'string' ? hexToBytes(data) : data;
    if (b.length < types.length * WORD)
        throw new Error('abi: data too short');
    const rd = (off) => {
        if (off < 0 || off + WORD > b.length)
            throw new Error('abi: out of bounds');
        return BigInt(bytesToHex(b.slice(off, off + WORD)));
    };
    const dec = (t, off) => {
        const w = rd(off);
        if (t === 'address') {
            if (w >> 160n)
                throw new Error('abi: dirty address');
            return '0x' + w.toString(16).padStart(40, '0');
        }
        if (t === 'bool') {
            if (w > 1n)
                throw new Error('abi: bad bool');
            return w === 1n;
        }
        if (t.startsWith('uint')) {
            const bits = t === 'uint' ? 256 : Number(t.slice(4));
            if (w >> BigInt(bits))
                throw new Error(`abi: ${t} overflow`);
            return w;
        }
        if (t === 'bytes32')
            return bytesToHex(b.slice(off, off + WORD));
        throw new Error(`unsupported type ${t}`);
    };
    return types.map((t, i) => {
        if (!isArr(t))
            return dec(t, i * WORD);
        const ptr = Number(rd(i * WORD)), len = Number(rd(ptr));
        const el = t.slice(0, -2);
        return Array.from({ length: len }, (_, k) => dec(el, ptr + WORD + k * WORD));
    });
}
