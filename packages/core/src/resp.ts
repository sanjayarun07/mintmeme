/** Minimal RESP2 encoder/decoder (enough for Redis commands: strings, integers, nulls, arrays, errors). No dependencies. */
export class RespError extends Error {}
export type RespValue = string | number | null | RespError | RespValue[];
export function encodeCommand(args: (string | number)[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) { const b = Buffer.from(String(a)); parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n')); }
  return Buffer.concat(parts);
}
function parseAt(b: Buffer, pos: number): [RespValue, number] | undefined {
  if (pos >= b.length) return undefined;
  const eol = b.indexOf('\r\n', pos); if (eol < 0) return undefined;
  const type = String.fromCharCode(b[pos]), line = b.toString('utf8', pos + 1, eol), next = eol + 2;
  switch (type) {
    case '+': return [line, next];
    case '-': return [new RespError(line), next];
    case ':': return [Number(line), next];
    case '$': { const n = Number(line); if (n < 0) return [null, next]; if (b.length < next + n + 2) return undefined; return [b.toString('utf8', next, next + n), next + n + 2]; }
    case '*': { const n = Number(line); if (n < 0) return [null, next]; const out: RespValue[] = []; let p = next;
      for (let i = 0; i < n; i++) { const r = parseAt(b, p); if (!r) return undefined; out.push(r[0]); p = r[1]; } return [out, p]; }
    default: throw new Error(`bad RESP type byte ${JSON.stringify(type)}`);
  }
}
/** Incremental: push() chunks, then next() until it returns undefined (value incomplete). */
export class RespParser {
  private buf: Buffer = Buffer.alloc(0);
  push(c: Buffer) { this.buf = Buffer.concat([this.buf, c]); }
  next(): { value: RespValue } | undefined { const r = parseAt(this.buf, 0); if (!r) return undefined; this.buf = this.buf.subarray(r[1]); return { value: r[0] }; }
}
