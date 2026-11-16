import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLaunches } from '../src/launchfeed.ts';
import { DevSolSigner, base58, b58decode, AMM_V4_LAYOUT } from '../../sol/src/index.ts';
import { SOL } from '../src/config.ts';

const sg = new DevSolSigner(), addr = () => sg.add(), PROGRAM = SOL.programs[0].address, WSOL = 'So11111111111111111111111111111111111111112', TOK = addr(), TOK2 = addr();
const tok = (o: any = {}) => ({ id: 'x', name: 'Name', sym: 'SYM', chain: 'ethereum', contract: '0xaaaa', pool: '0xpool', venue: 'Uniswap V2', verified: true, real: true, col: 'new', pad: null, stage: 'new', tokenAge: 5, poolAge: 5, price: 1, chg: 1, liq: 20_000, vol: 1, mcap: 1, fdv: 1, act: 1, color: '#fff', owner: null, findings: [], tax: null, source: 's', ...o });
const poolData = (base: string, quote: string) => { const b = Buffer.alloc(AMM_V4_LAYOUT.size); b.writeBigUInt64LE(6n, AMM_V4_LAYOUT.status); Buffer.from(b58decode(addr())).copy(b, AMM_V4_LAYOUT.baseVault); Buffer.from(b58decode(addr())).copy(b, AMM_V4_LAYOUT.quoteVault);
  Buffer.from(b58decode(base)).copy(b, AMM_V4_LAYOUT.baseMint); Buffer.from(b58decode(quote)).copy(b, AMM_V4_LAYOUT.quoteMint); return b; };
const mint = (o: { freeze?: string } = {}) => { const b = Buffer.alloc(82); b[45] = 1; if (o.freeze) { b.writeUInt32LE(1, 46); Buffer.from(b58decode(o.freeze)).copy(b, 50); } return { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [b.toString('base64'), 'base64'] }; };
function rpc(o: { creations?: boolean; freezeFor?: string } = {}) {
  const pool = addr();
  return { call: async (m: string, p: any[] = []): Promise<any> => {
    if (m === 'getSignaturesForAddress') return o.creations === false ? [] : [{ signature: 'sigA', err: null, slot: 100 }];
    if (m === 'getTransaction') return { slot: 100, transaction: { message: { accountKeys: [addr(), pool, PROGRAM], instructions: [{ programIdIndex: 2, accounts: [1], data: base58(new Uint8Array([1])) }] } }, meta: { err: null, preBalances: [1e10, 0, 1], postBalances: [1e10, 5e6, 1], innerInstructions: [] } };
    if (m === 'getMultipleAccounts') return { value: [{ owner: PROGRAM, data: [poolData(TOK, WSOL).toString('base64'), 'base64'] }] };
    if (m === 'getTokenAccountBalance') return { value: { amount: '5000000000' } };
    if (m === 'getBlockTime') return 1_000_000 - 7 * 60;
    if (m === 'getAccountInfo') return { value: mint(p[0] === o.freezeFor ? { freeze: addr() } : {}) };
    throw new Error('unscripted ' + m);
  } };
}
const fetchOk = (liq: number) => (async () => ({ json: async () => ({ pairs: [{ baseToken: { address: TOK, symbol: 'NEW', name: 'New Token' }, priceUsd: '0.001', liquidity: { usd: liq } }] }) })) as any;

test('launch feed: a real Raydium creation becomes a launch with name, age, mint check and a dry-run verdict; already-known tokens are not duplicated', async () => {
  const r = await loadLaunches({ rpc: { sol: rpc() }, fetchFn: fetchOk(30_000), now: () => 1_000_000_000 }, [tok({ col: 'active', pad: null })]);
  assert.equal(r.items.length, 1); const i = r.items[0]; assert.equal(i.source, 'raydium-creation'); assert.equal(i.sym, 'NEW'); assert.equal(i.contract, TOK); assert.equal(i.venue, 'Raydium AMM v4'); assert.equal(i.liqUsd, 30_000);
  assert.equal(i.verdict, 'warn'); assert.ok(i.flags.some(f => /both revoked|mint authority/.test(f)) || i.flags.length === 0); assert.equal(i.executable, true); assert.equal(i.dryRun.wouldBuy, true);
});

test('launch feed: a freeze authority blocks the dry-run buy and says why; thin liquidity and Pump.fun curves are explained, never hidden', async () => {
  const r = await loadLaunches({ rpc: { sol: rpc({ freezeFor: TOK }) }, fetchFn: fetchOk(1_000), now: () => 1_000_000_000 }, [tok({ chain: 'solana', contract: TOK2, venue: 'Pump.fun curve', pad: 'pump-fun', col: 'new', liq: 50_000 })]);
  const raydium = r.items.find(x => x.contract === TOK)!, pump = r.items.find(x => x.contract === TOK2)!;
  assert.equal(raydium.verdict, 'blocked'); assert.equal(raydium.dryRun.wouldBuy, false); assert.match(raydium.dryRun.why, /blocked/); assert.match(raydium.dryRun.why, /under the \$5,000/);
  assert.equal(pump.executable, false); assert.match(pump.dryRun.why, /Pump\.fun curves cannot be traded/);
});

test('launch feed: EVM tokens carry the loader\'s warnings, never claim a risk verdict they do not have, and a failing source degrades to a note', async () => {
  const bad = { call: async () => { throw new Error('node down'); } };
  const r = await loadLaunches({ rpc: { sol: bad as any }, fetchFn: fetchOk(1), now: () => 1 }, [tok({ findings: [{ lvl: 'warn', text: 'Owner can pause transfers', ago: 1 }] })]);
  assert.equal(r.items.length, 1); assert.equal(r.items[0].verdict, 'unchecked'); assert.deepEqual(r.items[0].flags, ['Owner can pause transfers']); assert.equal(r.items[0].executable, true);
  assert.match(r.items[0].dryRun.why, /EVM pre-trade sell\/tax simulation is not available/); assert.ok(r.notes.some(n => /Raydium pool-creation scan failed: node down/.test(n)));
});

test('launch feed: nothing created recently is reported as a plain note, and only launch-like tokens are listed', async () => {
  const r = await loadLaunches({ rpc: { sol: rpc({ creations: false }) }, now: () => 1 }, [tok({ col: 'active', pad: null }), tok({ contract: '0xbbbb', col: 'near' })]);
  assert.equal(r.items.length, 1); assert.equal(r.items[0].contract, '0xbbbb'); assert.ok(r.notes.some(n => /rare now/.test(n)));
});
