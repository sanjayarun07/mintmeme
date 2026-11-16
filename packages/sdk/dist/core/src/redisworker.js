/** Worker thread: owns the TCP connection to Redis and answers one command at a time. The main thread blocks on a shared flag (see SyncRedis). */
import { workerData } from 'node:worker_threads';
import { connect } from 'node:net';
import { encodeCommand, RespParser, RespError } from './resp.js';
const { host, port, password, flag, timeoutMs, mport } = workerData;
let sock;
let parser = new RespParser();
let waiter;
const drop = () => { sock?.destroy(); sock = undefined; parser = new RespParser(); waiter = undefined; };
function send(s, args) {
    return new Promise((res, rej) => {
        const t = setTimeout(() => { drop(); rej(new Error(`command timed out after ${timeoutMs}ms`)); }, timeoutMs);
        waiter = v => { clearTimeout(t); res(v); };
        s.write(encodeCommand(args), e => { if (e) {
            clearTimeout(t);
            rej(e);
        } });
    });
}
async function ensure() {
    if (sock && !sock.destroyed)
        return sock;
    const s = connect({ host, port });
    s.setNoDelay(true);
    await new Promise((res, rej) => { s.once('connect', res); s.once('error', rej); });
    s.on('data', c => { parser.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); for (let r = parser.next(); r; r = parser.next()) {
        const w = waiter;
        waiter = undefined;
        w?.(r.value);
    } });
    s.on('error', () => drop());
    s.on('close', () => { if (sock === s)
        drop(); });
    sock = s;
    if (password) {
        const r = await send(s, ['AUTH', password]);
        if (r instanceof RespError) {
            drop();
            throw new Error('authentication failed');
        }
    }
    return s;
}
let tail = Promise.resolve();
mport.on('message', (m) => {
    tail = tail.then(async () => {
        try {
            const v = await send(await ensure(), m.args);
            mport.postMessage(v instanceof RespError ? { ok: false, error: v.message } : { ok: true, v: v instanceof Array ? JSON.parse(JSON.stringify(v)) : v });
        }
        catch (e) {
            drop();
            mport.postMessage({ ok: false, error: `redis unreachable: ${e.message}` });
        }
        finally {
            Atomics.store(flag, 0, 1);
            Atomics.notify(flag, 0);
        }
    });
});
