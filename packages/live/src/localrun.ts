/** Runs the transaction-lifecycle scenarios our engine's reconcile design depends on against a REAL local node (loopback only).
 *  usage: node ... localrun.ts <rpc-url> [label]      L1 geth: funds from an unlocked node account. Otherwise set LOCAL_FUNDER_KEY (a funded TEST key on that local chain).
 *  Writes docs/live-verification/<ts>-localnode-<label>.md . Exit 1 on any failed check. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { LocalNode, newWallet, signRaw, hex, big } from './localnode.ts';
import type { Wallet } from './localnode.ts';

const ETH1 = 10n ** 18n;
export interface Check { name: string; pass: boolean; detail: string }

export async function runScenarios(node: LocalNode, funder: { unlocked?: string; wallet?: Wallet }): Promise<{ checks: Check[]; facts: string[] }> {
  const checks: Check[] = [], facts: string[] = [];
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); };
  const chainId = Number(big(await node.call('eth_chainId')));
  const client = await node.tryCall('web3_clientVersion'); facts.push(`chainId ${chainId}; client ${client.ok ? client.result : 'unknown'}; block ${big(await node.call('eth_blockNumber'))}`);
  const bal = async (a: string) => big(await node.call('eth_getBalance', [a, 'latest']));
  const nonceOf = async (a: string) => Number(big(await node.call('eth_getTransactionCount', [a, 'latest'])));
  const gp = big(await node.call('eth_gasPrice')); facts.push(`eth_gasPrice ${gp} wei`);
  const fee = 20n * gp > 2_000_000_000n ? 20n * gp : 2_000_000_000n;  // generous cap; effective price is what is charged
  const feeGwei = (x: bigint) => (Number(x) / 1e9).toFixed(9);

  // --- fund a throwaway wallet
  const a = newWallet(), b = newWallet();
  let fundHash: string;
  if (funder.unlocked) fundHash = await node.call('eth_sendTransaction', [{ from: funder.unlocked, to: a.address, value: hex(2n * ETH1) }]);
  else {
    const fw = funder.wallet!; const raw = signRaw(fw, { to: a.address, valueWei: 2n * ETH1, nonce: await nonceOf(fw.address), chainId, maxFeeGwei: feeGwei(fee), priorityGwei: feeGwei(gp) });
    fundHash = await node.call('eth_sendRawTransaction', [raw]);
  }
  const frc = await node.waitReceipt(fundHash);
  check('funding tx confirmed', frc.status === '0x1', `block ${big(frc.blockNumber)}`);
  check('throwaway wallet funded', (await bal(a.address)) === 2n * ETH1);

  // --- A: send, observe, fill from receipt balance deltas (never from the request)
  const value = ETH1 / 10n;
  const raw0 = signRaw(a, { to: b.address, valueWei: value, nonce: 0, chainId, maxFeeGwei: feeGwei(fee), priorityGwei: feeGwei(gp) });
  const aBefore = await bal(a.address), bBefore = await bal(b.address);
  const h0 = await node.call('eth_sendRawTransaction', [raw0]);
  const rc0 = await node.waitReceipt(h0);
  const gasCost = big(rc0.gasUsed) * big(rc0.effectiveGasPrice);
  const aDelta = (await bal(a.address)) - aBefore, bDelta = (await bal(b.address)) - bBefore;
  check('A1 receipt status success', rc0.status === '0x1');
  check('A2 recipient delta == value', bDelta === value, `delta ${bDelta}`);
  check('A3 sender delta == -(value + gasUsed*effectiveGasPrice)', aDelta === -(value + gasCost), `delta ${aDelta}, gas ${gasCost}`);
  const extra = Object.keys(rc0).filter(k => /l1|L1/.test(k));
  facts.push(`receipt gasUsed ${big(rc0.gasUsed)}, effectiveGasPrice ${big(rc0.effectiveGasPrice)}${extra.length ? `; extra L1 fields: ${extra.join(', ')}` : ''}`);
  check('A4 network fee derivable from receipt alone', gasCost > 0n, `${gasCost} wei`);

  // --- B: identical raw tx resubmitted after inclusion must not double-spend
  const again = await node.tryCall('eth_sendRawTransaction', [raw0]);
  facts.push(`resubmit of an INCLUDED tx -> ${again.ok ? 'accepted ' + again.result : 'rejected: ' + again.error}`);
  check('B1 resubmit of included tx does not create a second execution', (await nonceOf(a.address)) === 1 && (await bal(b.address)) === bBefore + value, again.ok ? 'node returned the same hash (idempotent)' : again.error);
  const stale = await node.tryCall('eth_sendRawTransaction', [signRaw(a, { to: b.address, valueWei: 1n, nonce: 0, chainId, maxFeeGwei: feeGwei(fee), priorityGwei: feeGwei(gp) })]);
  facts.push(`DIFFERENT tx at a consumed nonce -> ${stale.ok ? 'accepted?!' : 'rejected: ' + stale.error}`);
  check('B2 different tx at consumed nonce is rejected', !stale.ok, stale.ok ? '' : stale.error);

  // --- C: queued tx (nonce gap) stays pending; same-bytes resubmit is idempotent; lookup states
  const rawGap = signRaw(a, { to: b.address, valueWei: 1_000n, nonce: 3, chainId, maxFeeGwei: feeGwei(fee), priorityGwei: feeGwei(gp) });
  const g = await node.tryCall('eth_sendRawTransaction', [rawGap]);
  facts.push(`tx with a nonce gap (nonce 3, account nonce 1) -> ${g.ok ? 'accepted and queued ' + g.result : 'rejected: ' + g.error}`);
  if (!g.ok) {
    // Sequencer-style node (e.g. Arbitrum Nitro): no public mempool, so nothing can sit pending. The pending/replace scenarios do not apply.
    check('C0 node rejects nonce gaps immediately (no queue)', /nonce too high|nonce/i.test(g.error), g.error);
    facts.push('C/D (pending, duplicate-while-pending, replace-by-fee) NOT APPLICABLE on this node: there is no queue to hold a pending tx. On this node a submit is either sequenced almost at once or rejected, so the engine\'s pending-state and replace logic is unexercised here.');
    const nr = await node.tryCall('eth_sendRawTransaction', [signRaw(a, { to: b.address, valueWei: 1n, nonce: 1, chainId, maxFeeGwei: feeGwei(fee), priorityGwei: feeGwei(gp) })]);
    if (nr.ok) { const r1 = await node.waitReceipt(nr.result); check('C0b next-nonce tx is accepted and mined after a rejected gap tx', r1.status === '0x1'); }
    else check('C0b next-nonce tx is accepted after a rejected gap tx', false, nr.error);
    return { checks, facts };
  }
  const hGap = g.result;
  const seen = await node.call('eth_getTransactionByHash', [hGap]);
  check('C1 gapped tx is visible at the node but not mined', !!seen && seen.blockNumber === null, seen ? 'pending/queued' : 'node does not show queued txs');
  const dup = await node.tryCall('eth_sendRawTransaction', [rawGap]);
  facts.push(`resubmit of a PENDING tx -> ${dup.ok ? 'accepted ' + dup.result : 'rejected: ' + dup.error}`);
  check('C2 identical resubmit of pending tx does not duplicate', dup.ok ? dup.result === hGap : /already (known|imported)|known/i.test(dup.error), dup.ok ? 'same hash' : dup.error);
  const noRc = await node.call('eth_getTransactionReceipt', [hGap]);
  check('C3 no receipt while pending', noRc === null);

  // --- D: cancel/replace the pending nonce with a noop at higher fee; original must disappear and never execute
  const noop = signRaw(a, { to: a.address, valueWei: 0n, nonce: 3, chainId, maxFeeGwei: feeGwei(fee * 3n), priorityGwei: feeGwei(gp * 3n), gasLimit: 21_000n });
  const rep = await node.tryCall('eth_sendRawTransaction', [noop]);
  facts.push(`replace pending nonce 3 with a noop at 3x fee -> ${rep.ok ? 'accepted ' + rep.result : 'rejected: ' + rep.error}`);
  check('D1 replace-by-fee noop accepted', rep.ok, rep.ok ? '' : rep.error);
  const lowFee = await node.tryCall('eth_sendRawTransaction', [signRaw(a, { to: a.address, valueWei: 0n, nonce: 3, chainId, maxFeeGwei: feeGwei(fee), priorityGwei: feeGwei(gp), gasLimit: 21_001n })]);
  facts.push(`replace with a non-higher fee -> ${lowFee.ok ? 'accepted?!' : 'rejected: ' + lowFee.error}`);
  check('D2 replacement without a fee bump is rejected', !lowFee.ok, lowFee.ok ? '' : lowFee.error);
  const orig = await node.call('eth_getTransactionByHash', [hGap]);
  check('D3 replaced original is no longer known (engine reads this as "absent")', orig === null, orig ? 'still visible' : 'null');
  // Fill the gap (nonces 1 and 2) so the noop at 3 can be mined.
  for (const n of [1, 2]) await node.call('eth_sendRawTransaction', [signRaw(a, { to: a.address, valueWei: 0n, nonce: n, chainId, maxFeeGwei: feeGwei(fee), priorityGwei: feeGwei(gp), gasLimit: 21_000n })]);
  if (rep.ok) {
    const nrc = await node.waitReceipt(rep.result);
    check('D4 noop mined, nonce 3 consumed', nrc.status === '0x1' && (await nonceOf(a.address)) === 4);
    check('D5 original never executed (recipient got only the first transfer)', (await bal(b.address)) === bBefore + value, `b delta ${(await bal(b.address)) - bBefore}`);
    check('D6 original has no receipt', (await node.call('eth_getTransactionReceipt', [hGap])) === null);
  }

  // --- E: revert is mined, pays gas, and the receipt says failed
  // (plain native transfers cannot revert; use a self-call to a contract-less address with data to show EOAs accept it, then record honestly)
  facts.push('E (on-chain revert behaviour) needs a deployed contract; not exercised here. See KNOWN_LIMITATIONS.');
  return { checks, facts };
}

export function report(label: string, url: string, r: { checks: Check[]; facts: string[] }) {
  const pass = r.checks.every(c => c.pass);
  const lines = [`# Local node lifecycle check — ${label}`, '', `Run: ${new Date().toISOString()}`, `Node: ${url} (loopback; a local test chain, NOT mainnet or a public testnet)`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${r.checks.filter(c => c.pass).length}/${r.checks.length} checks)`, '',
    'What this shows: how a real node (not our simulator) answers the situations the engine\'s reconcile design relies on. Throwaway keys, local funds only; keys are not recorded here.', '', '## Observed node behaviour', ...r.facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...r.checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- The engine itself is not yet wired to a real node (it runs against the in-memory simulator); these checks validate the assumptions it makes.', '- No DEX swap: a bare local chain has no Uniswap/Raydium contracts. Swap fork tests need a mainnet fork (needs `ALCHEMY_API_KEY`).'];
  return { text: lines.join('\n') + '\n', pass };
}

async function main() {
  const url = process.argv[2], label = process.argv[3] ?? 'node';
  if (!url) { console.error('usage: localrun.ts <rpc-url> [label]'); process.exit(2); }
  const node = new LocalNode(url);
  let funder: { unlocked?: string; wallet?: Wallet };
  const acc = await node.tryCall('eth_accounts');
  if (acc.ok && acc.result.length) {
    // pick an unlocked account that can afford the 2 ETH test funding (first with >= 100 ETH); accounts with no funds are skipped
    let pick: string | undefined;
    for (const a of acc.result as string[]) if (BigInt(await node.call('eth_getBalance', [a, 'latest'])) >= 100n * ETH1) { pick = a; break; }
    if (!pick) { console.error('No unlocked account on this node holds >= 100 ETH. Set LOCAL_FUNDER_KEY.'); process.exit(2); }
    funder = { unlocked: pick };
  }
  else if (process.env.LOCAL_FUNDER_KEY) { const { execFileSync } = await import('node:child_process'); funder = { wallet: { key: process.env.LOCAL_FUNDER_KEY, address: execFileSync('cast', ['wallet', 'address', '--private-key', process.env.LOCAL_FUNDER_KEY], { encoding: 'utf8' }).trim().toLowerCase() } }; }
  else { console.error('No unlocked account on this node. Set LOCAL_FUNDER_KEY to a funded TEST key for this local chain.'); process.exit(2); }
  const r = await runScenarios(node, funder);
  const rep = report(label, url, r);
  mkdirSync('docs/live-verification', { recursive: true });
  const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-localnode-${label}.md`;
  writeFileSync(file, rep.text);
  for (const c of r.checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + c.detail}`);
  console.log(`\nreport: ${file}`);
  process.exit(rep.pass ? 0 : 1);
}
if (process.argv[1]?.endsWith('localrun.ts')) main().catch(e => { console.error(e.message); process.exit(1); });
