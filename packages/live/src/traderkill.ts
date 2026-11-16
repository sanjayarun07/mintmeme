/** OS-LEVEL KILL TEST FOR THE SDK TRADER. The real `Trader` runs a TWAP and a limit buy in a separate Node process over a loopback anvil fork. The parent kills that process with SIGKILL (once from inside, right before a
 *  transaction would leave; then from outside right after a slice was sent) and starts a fresh process that is given NO instructions: it only calls trader.resume(). The order must still finish, every slice traded exactly once,
 *  the limit order and the position must be back, and no private key may be on disk. Local only: throwaway keys, fake ETH. usage: npm run verify:trader-kill (needs ALCHEMY_API_KEY in .env and Foundry). */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newWallet, hex, big } from './localnode.ts';
import { erc20 } from '../../evm/src/index.ts';
import { startFork } from './forkenv.ts';
import { ETH } from './config.ts';
import type { Check } from './localrun.ts';

const PORT = 8672, ETH1 = 10n ** 18n, usdc = ETH.usdc.address.toLowerCase();

async function main() {
  const key = process.env.ALCHEMY_API_KEY; if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env and run again.'); process.exit(2); }
  const checks: Check[] = [], facts: string[] = [];
  let fork: Awaited<ReturnType<typeof startFork>> | undefined; const redact = (s: string) => (fork ? fork.redact(s) : s.split(key).join('***'));
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail: redact(detail) }); };
  try {
    fork = await startFork(key, PORT); const node = fork.node;
    const nonceOf = async (a: string) => Number(big(await node.call<string>('eth_getTransactionCount', [a, 'latest'])));
    const usdcOf = async (a: string) => { const q = erc20.balanceOf(usdc, a); return erc20.decodeUint(await node.call<string>('eth_call', [{ to: q.to, data: q.data }, 'latest'])); };
    const head: any = await node.call('eth_getBlockByNumber', ['latest', false]); facts.push(`fork of mainnet at block ${big(head.number)}; the Trader runs in separate Node processes started and killed by this parent; a restarted process creates nothing, it only calls trader.resume()`);
    const runWorker = async (kw: object, stopWhen?: (s: any) => boolean) => {
      const child: ChildProcess = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', 'packages/live/src/traderkillworker.ts'], { env: { PATH: process.env.PATH!, KW: JSON.stringify(kw) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let last: any, err = '', buf = '', killedByParent = false; child.stderr!.on('data', d => { err += d; });
      child.stdout!.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.startsWith('S ')) { const o = JSON.parse(l.slice(2)); if (o.event !== 'tick') continue; last = o; if (stopWhen?.(last) && !killedByParent) { killedByParent = true; child.kill('SIGKILL'); } } } });
      const miner = setInterval(() => { node.call('anvil_mine', ['0x1']).catch(() => {}); }, 300);
      const code = await new Promise<{ code: number | null; signal: string | null }>(r => { child.on('exit', (code, signal) => r({ code, signal })); setTimeout(() => child.kill('SIGKILL'), 120000).unref(); });
      clearInterval(miner); for (let i = 0; i < 3; i++) await node.call('anvil_mine', ['0x1']);   // a transaction sent just before the kill may still be waiting: let the chain include it before anyone counts nonces
      return { ...code, last, err: err.slice(0, 400), killedByParent };
    };
    const advance = async (s: number) => { await node.call('evm_increaseTime', [hex(BigInt(s))]); await node.call('anvil_mine', ['0x1']); };
    const w = newWallet(); await node.call('anvil_setBalance', [w.address, hex(10n * ETH1)]);
    const dir = mkdtempSync(join(tmpdir(), 'memedesk-traderkill-')), t0 = Number(big(head.timestamp)) + 1;
    const K = (extra: object = {}) => ({ url: node.url, dir, wallets: [w], startAt: t0, ...extra });

    const a1 = await runWorker(K({ killBeforeSend: true }));
    check('TK1 the Trader process was killed by SIGKILL right before slice 1 would have been sent: nothing was sent, and its state files already exist', a1.signal === 'SIGKILL' && await nonceOf(w.address) === 0 && readdirSync(join(dir, 'trader')).includes('trader.json'), `signal ${a1.signal}, nonce ${await nonceOf(w.address)}, files ${readdirSync(join(dir, 'trader')).join(' ')}`);
    const a2 = await runWorker(K(), s => s.statuses[0] !== 'pending');
    check('TK2 a fresh process, told nothing, found the TWAP and the limit order from the files, sent slice 1 once, and was killed from outside right after', a2.killedByParent && a2.last?.fresh === false && await nonceOf(w.address) === 1 && a2.last?.order === 'active', `signal ${a2.signal}, fresh ${a2.last?.fresh}, statuses ${a2.last?.statuses}, nonce ${await nonceOf(w.address)}, order ${a2.last?.order}`);
    for (let i = 0; i < 4; i++) await node.call('anvil_mine', ['0x1']); await advance(300);
    const a3 = await runWorker(K(), s => s.statuses[1] !== 'pending');
    check('TK3 a third process saw slice 1 on chain and did not resend it; it sent slice 2 once and was killed after that', a3.killedByParent && await nonceOf(w.address) === 2, `slice 1 status seen: ${a3.last?.statuses?.[0]}; statuses ${a3.last?.statuses}; exit ${a3.code}, signal ${a3.signal}, killedByParent ${a3.killedByParent}; nonce ${await nonceOf(w.address)}; err ${a3.err}`);
    for (let i = 0; i < 4; i++) await node.call('anvil_mine', ['0x1']); await advance(300);
    const a4 = await runWorker(K());
    const n = await nonceOf(w.address), u = await usdcOf(w.address);
    check('TK4 a fourth process finished the TWAP: 3 of 3 slices filled, exactly 3 transactions across four processes, and the wallet\'s USDC equals what the TWAP says it received', a4.code === 0 && a4.last?.done === true && a4.last?.filled === 3 && n === 3 && String(u) === String(a4.last?.received), `exit ${a4.code}, filled ${a4.last?.filled}, nonce ${n}, usdc ${u}, received ${a4.last?.received}; statuses ${a4.last?.statuses}; reasons ${JSON.stringify(a4.last?.reasons)}; due ${a4.last?.due}; chain time ${a4.last?.time}`);
    check('TK5 after all those restarts the far-away limit buy is still active and was never fired', a4.last?.order === 'active' && n === 3, `order ${a4.last?.order}`);
    check('TK6 the position the Trader reports after the restarts equals the wallet\'s real USDC balance (rebuilt from the engine records)', String(a4.last?.position) === String(u), `reported ${a4.last?.position}, on chain ${u}`);
    const onDisk = [join(dir, 'engine.json'), ...readdirSync(join(dir, 'trader')).map(f => join(dir, 'trader', f))].map(f => readFileSync(f, 'utf8')).join('');
    check('TK7 no private key is written to any state file', !onDisk.includes(w.key.slice(2)));
  } catch (e) { check('TK0 the run completed without an error', false, (e as Error).message); }
  finally { fork?.stop(); }
  const pass = checks.every(c => c.pass);
  const text = ['# OS-level kill test: the SDK Trader', '', `Run: ${new Date().toISOString()}`, 'Node: local anvil fork; NOT mainnet. Throwaway keys, fake ETH, dev-only signer.', `Result: **${pass ? 'PASS' : 'FAIL'}** (${checks.filter(c => c.pass).length}/${checks.length} checks)`, '',
    'What this shows: the real Trader runs a TWAP and a limit buy in a separate process that is killed with SIGKILL (once by itself right before a transaction would leave, twice from outside right after a slice was sent). Each fresh process is given no instructions and only calls resume(); it finds the TWAP and the order in the state files and finishes, every slice traded exactly once.', '',
    '## Observed', ...facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- A kill during a state-file write (files are written to a temp file and renamed; a torn write was not simulated).', '- Power loss or disk faults: SIGKILL ends the process but the operating system still flushes its writes.', '- Kills at other moments than the three chosen ones; Redis-backed state (covered by unit tests, not by this OS-level run).', '- Snipe and copy runners (they need a source supplied by the host).'].join('\n') + '\n';
  mkdirSync('docs/live-verification', { recursive: true }); const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-trader-kill.md`; writeFileSync(file, redact(text));
  for (const c of checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + c.detail}`); console.log(`\nreport: ${file}`); process.exit(pass ? 0 : 1);
}
main();
