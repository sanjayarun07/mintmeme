/** A small PostgreSQL client with no dependencies (like redis.ts for Redis): one connection, queries run one at a time in order.
 *  Protocol 3.0 (https://www.postgresql.org/docs/current/protocol.html): SSLRequest + TLS when asked (`sslmode=require`, or `verify-full` to also check the
 *  certificate), password login by SCRAM-SHA-256 (RFC 5802/7677, the server default), MD5 or cleartext, and the extended query protocol with text parameters
 *  ($1, $2 ... never interpolated into SQL). Results come back as rows of strings (or null) keyed by column name.
 *  A broken connection is reopened on the next query; a query in flight when it broke fails with the error. */
import net from 'node:net';
import tls from 'node:tls';
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
export class PgError extends Error {
    code;
    detail;
    constructor(message, code, detail) {
        super(message);
        this.code = code;
        this.detail = detail;
    }
}
export function parsePgUrl(url) {
    const u = new URL(url);
    if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:')
        throw new Error('a Postgres URL starts with postgres://');
    const ssl = u.searchParams.get('sslmode') ?? 'disable';
    if (!['disable', 'require', 'verify-full'].includes(ssl))
        throw new Error('sslmode must be disable, require or verify-full');
    return { host: u.hostname || '127.0.0.1', port: Number(u.port || 5432), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: decodeURIComponent(u.pathname.slice(1)) || decodeURIComponent(u.username), ssl };
}
export class PgClient {
    url;
    o;
    sock;
    buf = Buffer.alloc(0);
    chain = Promise.resolve();
    waiter;
    ready;
    constructor(url, o = {}) {
        this.url = url;
        this.o = o;
        parsePgUrl(url);
    }
    /** Run one statement with $1.. parameters (sent as text; null stays NULL). Queries on one client run in order. */
    query(sql, params = []) {
        const run = this.chain.then(() => this.exec(sql, params));
        this.chain = run.catch(() => { });
        return run;
    }
    async close() { const s = this.sock; this.sock = undefined; this.ready = undefined; if (s) {
        try {
            s.write(msg('X', Buffer.alloc(0)));
        }
        catch { /* closing anyway */ }
        s.destroy();
    } }
    async exec(sql, params) {
        await (this.ready ??= this.open().catch(e => { this.ready = undefined; throw e; }));
        const vals = params.map(p => (p === null || p === undefined ? null : typeof p === 'object' ? JSON.stringify(p, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) : String(p)));
        const bind = [cstr(''), cstr(''), u16(0), u16(vals.length), ...vals.flatMap(v => (v === null ? [i32(-1)] : [i32(Buffer.byteLength(v)), Buffer.from(v)])), u16(0)];
        this.sock.write(Buffer.concat([msg('P', Buffer.concat([cstr(''), cstr(sql), u16(0)])), msg('B', Buffer.concat(bind)), msg('D', Buffer.concat([Buffer.from('P'), cstr('')])), msg('E', Buffer.concat([cstr(''), i32(0)])), msg('S', Buffer.alloc(0))]));
        let cols = [];
        const rows = [];
        let command = '', err;
        await this.until((t, b) => {
            if (t === 'T') {
                const n = b.readUInt16BE(0);
                let p = 2;
                cols = [];
                for (let i = 0; i < n; i++) {
                    const e = b.indexOf(0, p);
                    cols.push(b.toString('utf8', p, e));
                    p = e + 1 + 18;
                }
            }
            else if (t === 'D') {
                const n = b.readUInt16BE(0);
                let p = 2;
                const r = {};
                for (let i = 0; i < n; i++) {
                    const l = b.readInt32BE(p);
                    p += 4;
                    r[cols[i]] = l < 0 ? null : b.toString('utf8', p, p + l);
                    if (l > 0)
                        p += l;
                }
                rows.push(r);
            }
            else if (t === 'C')
                command = b.toString('utf8', 0, b.length - 1);
            else if (t === 'E')
                err = pgError(b);
            return t === 'Z';
        });
        if (err)
            throw err;
        return { rows, command, rowCount: Number(command.split(' ').pop()) || rows.length };
    }
    async open() {
        const c = parsePgUrl(this.url), timeout = this.o.timeoutMs ?? 10_000;
        let s = await new Promise((ok, no) => { const x = net.connect(c.port, c.host); x.setTimeout(timeout, () => x.destroy(new Error('Postgres connect timeout'))); x.once('connect', () => { x.setTimeout(0); ok(x); }); x.once('error', no); });
        if (c.ssl !== 'disable') {
            s.write(Buffer.concat([i32(8), i32(80877103)])); // SSLRequest
            const a = await new Promise((ok, no) => { s.once('data', d => ok(d.toString('latin1', 0, 1))); s.once('error', no); });
            if (a !== 'S') {
                s.destroy();
                throw new PgError('the server does not offer TLS, but sslmode requires it');
            }
            s = await new Promise((ok, no) => { const t = tls.connect({ socket: s, servername: net.isIP(c.host) ? undefined : c.host, rejectUnauthorized: c.ssl === 'verify-full' }, () => ok(t)); t.once('error', no); });
        }
        this.sock = s;
        this.buf = Buffer.alloc(0);
        s.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
        const gone = (e) => { if (this.sock === s) {
            this.sock = undefined;
            this.ready = undefined;
        } this.waiter?.fail(e ?? new PgError('Postgres connection closed')); };
        s.on('error', gone);
        s.on('close', () => gone());
        const params = Buffer.concat([cstr('user'), cstr(c.user), cstr('database'), cstr(c.database), cstr('application_name'), cstr('memedesk'), cstr('client_encoding'), cstr('UTF8'), Buffer.from([0])]);
        s.write(Buffer.concat([i32(8 + params.length), i32(196608), params]));
        let scram, err;
        await this.until((t, b) => {
            if (t === 'E') {
                err = pgError(b);
                return true;
            }
            if (t === 'R') {
                const kind = b.readInt32BE(0);
                if (kind === 3)
                    s.write(msg('p', cstr(c.password))); // cleartext
                else if (kind === 5) {
                    const inner = createHash('md5').update(c.password + c.user).digest('hex');
                    s.write(msg('p', cstr('md5' + createHash('md5').update(inner).update(b.subarray(4, 8)).digest('hex'))));
                }
                else if (kind === 10) {
                    if (!b.toString('utf8', 4).split('\0').includes('SCRAM-SHA-256')) {
                        err = new PgError('the server offers no supported SASL mechanism');
                        return true;
                    }
                    const nonce = randomBytes(18).toString('base64'), first = `n=,r=${nonce}`;
                    scram = { nonce, first };
                    s.write(msg('p', Buffer.concat([cstr('SCRAM-SHA-256'), i32(Buffer.byteLength('n,,' + first)), Buffer.from('n,,' + first)])));
                }
                else if (kind === 11 && scram) {
                    const server = b.toString('utf8', 4), f = Object.fromEntries(server.split(',').map(x => [x[0], x.slice(2)]));
                    if (!f.r?.startsWith(scram.nonce)) {
                        err = new PgError('SCRAM: the server nonce does not extend ours');
                        return true;
                    }
                    const salted = pbkdf2Sync(c.password, Buffer.from(f.s, 'base64'), Number(f.i), 32, 'sha256'), ck = hmac(salted, 'Client Key'), sk = createHash('sha256').update(ck).digest();
                    const without = `c=biws,r=${f.r}`, auth = `${scram.first},${server},${without}`, sig = hmac(sk, auth), proof = Buffer.from(ck.map((x, i) => x ^ sig[i]));
                    scram.serverSig = hmac(hmac(salted, 'Server Key'), auth);
                    s.write(msg('p', Buffer.from(`${without},p=${proof.toString('base64')}`)));
                }
                else if (kind === 12 && scram?.serverSig) {
                    const v = Buffer.from(b.toString('utf8', 4).replace(/^v=/, ''), 'base64');
                    if (v.length !== 32 || !timingSafeEqual(v, scram.serverSig)) {
                        err = new PgError('SCRAM: the server could not prove it knows the password');
                        return true;
                    }
                }
                else if (kind !== 0) {
                    err = new PgError(`unsupported Postgres authentication method ${kind}`);
                    return true;
                }
            }
            return t === 'Z';
        });
        if (err) {
            s.destroy();
            throw err;
        }
    }
    /** Feed server messages to `f` until it returns true. */
    until(f) {
        return new Promise((ok, no) => {
            const h = setTimeout(() => { this.waiter = undefined; this.sock?.destroy(); no(new PgError('Postgres did not answer in time')); }, this.o.timeoutMs ?? 30_000);
            this.waiter = { onMsg: (t, b) => { if (f(t, b)) {
                    clearTimeout(h);
                    this.waiter = undefined;
                    ok();
                } }, fail: e => { clearTimeout(h); this.waiter = undefined; no(e); } };
            this.drain();
        });
    }
    drain() {
        while (this.waiter && this.buf.length >= 5) {
            const len = this.buf.readInt32BE(1);
            if (this.buf.length < 1 + len)
                return;
            const t = this.buf.toString('latin1', 0, 1), b = this.buf.subarray(5, 1 + len);
            this.buf = this.buf.subarray(1 + len);
            if (t === 'N' || t === 'S' || t === 'K')
                continue; // notices, parameter status, backend key: not needed
            this.waiter.onMsg(t, b);
        }
    }
}
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }, i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const cstr = (s) => Buffer.concat([Buffer.from(s), Buffer.from([0])]);
const msg = (t, body) => Buffer.concat([Buffer.from(t), i32(body.length + 4), body]);
const hmac = (k, s) => createHmac('sha256', k).update(s).digest();
function pgError(b) { const f = {}; let p = 0; while (p < b.length && b[p] !== 0) {
    const e = b.indexOf(0, p + 1);
    f[String.fromCharCode(b[p])] = b.toString('utf8', p + 1, e);
    p = e + 1;
} return new PgError(f.M ?? 'Postgres error', f.C, f.D); }
