/** OS-LEVEL KILL TEST for TWAP and bulk orders. A worker PROCESS runs the order against a loopback anvil fork; this parent kills it with SIGKILL (once the process kills itself right before a
 *  transaction is sent, once from outside right after one was sent), starts a fresh process each time, and checks that the order finishes with every slice or leg traded EXACTLY once.
 *  Local only: throwaway keys, fake ETH. usage: npm run verify:kill (needs ALCHEMY_API_KEY in .env and Foundry's anvil/cast). Writes a report to docs/live-verification/. */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newWallet, hex, big } from './localnode.ts';
import { erc20 } from '../../evm/src/index.ts';
import { startFork } from './forkenv.ts';
import { ETH } from './config.ts';
import type { Check } from './localrun.ts';

const PORT = 8671, ETH1 = 10n ** 18n, usdc = ETH.usdc.address.toLowerCase();

async function main() {
  const key = process.env.ALCHEMY_API_KEY; if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env and run again.'); process.exit(2); }
  const checks: Check[] = [], facts: string[] = [];
  let fork: Awaited<ReturnType<typeof startFork>> | undefined; const redact = (s: string) => (fork ? fork.redact(s) : s.split(key).join('***'));
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail: redact(detail) }); };
  try {
    fork = await startFork(key, PORT); const node = fork.node;
    const nonceOf = async (a: string) => Number(big(await node.call<string>('eth_getTransactionCount', [a, 'latest'])));
    const usdcOf = async (a: string) => { const q = erc20.balanceOf(usdc, a); return erc20.decodeUint(await node.call<string>('eth_call', [{ to: q.to, data: q.data }, 'latest'])); };
    const head: any = await node.call('eth_getBlockByNumber', ['latest', false]); facts.push(`fork of mainnet at block ${big(head.number)}; worker processes are separate Node processes started and killed by this parent`);
    /** Run one worker until it exits or `stopWhen` is true for its latest summary, in which case it is killed with SIGKILL. A background task mines a block every 300 ms like a live chain. */
    const runWorker = async (kw: object, stopWhen?: (s: any) => boolean) => {
      const child: ChildProcess = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', 'packages/live/src/killworker.ts'], { env: { PATH: process.env.PATH!, KW: JSON.stringify(kw) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let last: any, err = '', buf = '', killedByParent = false; child.stderr!.on('data', d => { err += d; });
      child.stdout!.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.startsWith('S ')) { const o = JSON.parse(l.slice(2)); if (o.event !== 'tick') continue; last = o; if (stopWhen?.(last) && !killedByParent) { killedByParent = true; child.kill('SIGKILL'); } } } });
      const miner = setInterval(() => { node.call('anvil_mine', ['0x1']).catch(() => {}); }, 300);
      const code = await new Promise<{ code: number | null; signal: string | null }>(r => { child.on('exit', (code, signal) => r({ code, signal })); setTimeout(() => child.kill('SIGKILL'), 120000).unref(); });
      clearInterval(miner); return { ...code, last, err: err.slice(0, 400), killedByParent };
    };
    const advance = async (s: number) => { await node.call('evm_increaseTime', [hex(BigInt(s))]); await node.call('anvil_mine', ['0x1']); };

    // ===== TWAP: 3 slices, 5 minutes apart. Kill #1 before slice 1 is sent, kill #2 right after slice 1 is sent, kill #3 right after slice 2 is sent.
    const tw = newWallet(); await node.call('anvil_setBalance', [tw.address, hex(10n * ETH1)]);
    const tdir = mkdtempSync(join(tmpdir(), 'memedesk-kill-twap-')), t0 = Number(big(head.timestamp)) + 1;
    const T = (extra: object = {}) => ({ url: node.url, dir: tdir, mode: 'twap', wallets: [tw], startAt: t0, ...extra });
    const a1 = await runWorker(T({ killBeforeSend: true }));
    check('K1 TWAP: the worker process was killed by SIGKILL right before its first transaction would have been sent, and nothing was sent', a1.signal === 'SIGKILL' && await nonceOf(tw.address) === 0, `signal ${a1.signal}, nonce ${await nonceOf(tw.address)}`);
    const a2 = await runWorker(T(), s => s.statuses[0] !== 'pending');
    check('K2 TWAP: a fresh process resumed from the files, sent slice 1 once, and was killed from outside right after the send', a2.killedByParent && a2.signal === 'SIGKILL' && await nonceOf(tw.address) === 1, `signal ${a2.signal}, statuses ${a2.last?.statuses}, nonce ${await nonceOf(tw.address)}`);
    for (let i = 0; i < 4; i++) await node.call('anvil_mine', ['0x1']); await advance(300);
    const a3 = await runWorker(T(), s => s.statuses[1] !== 'pending');
    check('K3 TWAP: a third process found slice 1 already on chain and did not send it again; it sent slice 2 once and was killed after that', a3.killedByParent && await nonceOf(tw.address) === 2, `slice 1 status seen: ${a3.last?.statuses?.[0]}; nonce ${await nonceOf(tw.address)}`);
    for (let i = 0; i < 4; i++) await node.call('anvil_mine', ['0x1']); await advance(300);
    const a4 = await runWorker(T());
    const tn = await nonceOf(tw.address), tu = await usdcOf(tw.address);
    check('K4 TWAP: a fourth process finished the order: 3 of 3 slices filled, exactly 3 transactions in all across four processes, and the wallet\'s USDC equals what the order says it received', a4.code === 0 && a4.last?.done === true && a4.last?.filled === 3 && tn === 3 && String(tu) === String(a4.last?.received), `exit ${a4.code}, filled ${a4.last?.filled}, nonce ${tn}, USDC ${tu}, order says ${a4.last?.received}${a4.err ? ', stderr ' + a4.err : ''}`);

    // ===== BULK: 3 wallets, one leg each, one after another. Kill #1 before leg 1 is sent, kill #2 right after leg 1 is sent, then run to the end.
    const bw = [newWallet(), newWallet(), newWallet()]; for (const w of bw) await node.call('anvil_setBalance', [w.address, hex(10n * ETH1)]);
    const bdir = mkdtempSync(join(tmpdir(), 'memedesk-kill-bulk-')); const B = (extra: object = {}) => ({ url: node.url, dir: bdir, mode: 'bulk', wallets: bw, ...extra });
    const b1 = await runWorker(B({ killBeforeSend: true }));
    check('K5 bulk: the process was killed by SIGKILL right before the first leg\'s transaction would have been sent, and no wallet sent anything', b1.signal === 'SIGKILL' && (await Promise.all(bw.map(w => nonceOf(w.address)))).every(n => n === 0));
    const b2 = await runWorker(B(), s => s.statuses[0] !== 'pending');
    const bn2 = await Promise.all(bw.map(w => nonceOf(w.address)));
    check('K6 bulk: a fresh process resumed, sent leg 1 once, and was killed right after; the other wallets had sent nothing yet', b2.killedByParent && bn2.join() === '1,0,0', `signal ${b2.signal}, nonces ${bn2.join()}`);
    for (let i = 0; i < 4; i++) await node.call('anvil_mine', ['0x1']);
    const b3 = await runWorker(B());
    const bn3 = await Promise.all(bw.map(w => nonceOf(w.address))), bu = await Promise.all(bw.map(w => usdcOf(w.address)));
    check('K7 bulk: a third process finished: all 3 legs filled, each wallet sent exactly one transaction across three processes, and every wallet holds USDC', b3.code === 0 && b3.last?.done === true && b3.last?.filled === 3 && bn3.every(n => n === 1) && bu.every(u => u > 0n), `exit ${b3.code}, filled ${b3.last?.filled}, nonces ${bn3.join()}, USDC ${bu.join()}${b3.err ? ', stderr ' + b3.err : ''}`);
    const onDisk = [join(tdir, 'engine.json'), join(tdir, 'twap.json'), join(bdir, 'engine.json'), join(bdir, 'bulk.json')].map(f => readFileSync(f, 'utf8')).join('');
    check('K8 no private key is written to any of the four state files', ![tw, ...bw].some(w => String(onDisk).includes(w.key.slice(2))));
  } catch (e) { check('K0 the run completed without an error', false, (e as Error).message); }
  finally { fork?.stop(); }
  const pass = checks.every(c => c.pass);
  const text = ['# OS-level kill test: TWAP and bulk orders', '', `Run: ${new Date().toISOString()}`, `Node: local anvil fork; NOT mainnet. Throwaway keys, fake ETH, dev-only signer.`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${checks.filter(c => c.pass).length}/${checks.length} checks)`, '',
    'What this shows: an order runs in a separate worker process that is killed with SIGKILL, once by itself right before a transaction would leave and once from outside right after one was sent. A fresh process started from the saved files finishes the order, and every slice or leg was traded exactly once (checked by wallet nonce). Unlike the in-process restart checks, nothing in memory survives.', '',
    '## Observed', ...facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- A kill in the middle of a state-file write (the files are written whole each time; a torn write was not simulated).', '- A power loss or disk fault: SIGKILL ends the process but the operating system still flushes its file writes.', '- The kill happens at two chosen points, not at every possible instruction.', '- A live chain; the node here is a local fork and mines every 300 ms.', ''].join('\n');
  mkdirSync('docs/live-verification', { recursive: true }); const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-kill-test.md`; writeFileSync(file, redact(text));
  for (const c of checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + c.detail}`); console.log(`\nreport: ${file}`); process.exit(pass ? 0 : 1);
}
main();
