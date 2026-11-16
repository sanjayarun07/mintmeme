/** Worker process for the OS-level kill test (killtest.ts). It runs ONE TWAP or bulk order against a loopback anvil fork, prints a JSON summary line after every tick, and is killed by the
 *  parent with SIGKILL (or kills itself right before its first transaction is sent). All state lives in two files; a fresh worker started later resumes from those files only. Local fork, throwaway keys. */
import { Engine, Router, Store, PolicySigner, NATIVE, TwapRunner, BulkRunner } from '../../core/src/index.ts';
import type { WalletPolicy } from '../../core/src/index.ts';
import { EvmRpcChain, encodeCall, decodeParams } from '../../evm/src/index.ts';
import { LocalNode } from './localnode.ts';
import { CastSigner, FaultRpc } from './enginefork.ts';
import { ETH } from './config.ts';
import { join } from 'node:path';

const cfg = JSON.parse(process.env.KW ?? '{}') as { url: string; dir: string; mode: 'twap' | 'bulk'; wallets: { address: string; key: string }[]; startAt?: number; killBeforeSend?: boolean };
const ETH1 = 10n ** 18n, usdc = ETH.usdc.address.toLowerCase(), router = ETH.uniswapV2Router02.address, factory = ETH.uniswapV2Factory.address;
const out = (o: unknown) => console.log('S ' + JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

const node = new LocalNode(cfg.url), rpc = new FaultRpc(node), signer = new CastSigner();
for (const w of cfg.wallets) signer.add({ address: w.address.toLowerCase(), key: w.key });
const weth = String(decodeParams(['address'], await node.call<string>('eth_call', [{ to: router, data: encodeCall('WETH()', []) }, 'latest']))[0]).toLowerCase();
const pair = String(decodeParams(['address'], await node.call<string>('eth_call', [{ to: factory, data: encodeCall('getPair(address,address)', [weth, usdc]) }, 'latest']))[0]);
const chain = new EvmRpcChain({ id: 'evm-fork', chainId: 1, router, weth, pools: [{ id: 'uni:WETH-USDC', pair }], finalityDepth: 3 }, rpc, signer);
const pol = (): WalletPolicy => ({ userId: 'u1', chains: ['evm-fork'], allowedVenues: ['uniswap-v2'], maxPerTx: { [NATIVE]: 5n * ETH1, [usdc]: 10n ** 12n }, dailyLimit: { [NATIVE]: 100n * ETH1, [usdc]: 10n ** 13n }, destinations: [], deviceSecret: 'dev' });
const addrs = cfg.wallets.map(w => w.address.toLowerCase());
const store = Store.open(join(cfg.dir, 'engine.json')), engine = new Engine({ store, chain, signer: new PolicySigner(new Map(addrs.map(a => [a, 'x'])), new Map(addrs.map(a => [a, pol()]))), router: new Router(chain), platformFeeBps: 0 });
const file = join(cfg.dir, cfg.mode + '.json');
const runner = cfg.mode === 'twap'
  ? new TwapRunner({ engine, chain, persistPath: file, spec: { id: 'kt', userId: 'u1', walletId: addrs[0], chain: 'evm-fork', token: usdc, quoteToken: NATIVE, venues: ['uniswap-v2'], side: 'buy', total: 3n * ETH1 / 10n, slices: 3, intervalS: 300, startAt: cfg.startAt, slippageBps: 500 } })
  : new BulkRunner({ engine, chain, persistPath: file, spec: { id: 'kb', userId: 'u1', chain: 'evm-fork', token: usdc, quoteToken: NATIVE, venues: ['uniswap-v2'], side: 'buy', legs: addrs.map(a => ({ walletId: a, amount: ETH1 / 20n })), slippageBps: 500, mode: 'sequential' } });

await chain.refresh('venues');
if (cfg.killBeforeSend) rpc.beforeSend = async () => { out({ event: 'about-to-send-then-killed' }); process.kill(process.pid, 'SIGKILL'); };   // an abrupt OS-level death after the write-ahead checkpoint and before the transaction leaves
await runner.resume();                                                                          // no-op on a fresh start; on a restart it finishes the hand-over and re-attaches to engine records
for (;;) {
  await runner.tick(); await runner.settle(); await chain.refresh('venues');
  const s: any = runner.summary(); out({ event: 'tick', mode: cfg.mode, statuses: (s.slices ?? s.legs).map((x: any) => x.status), filled: s.filled, done: s.done, received: s.received });
  if (s.done) break; await new Promise(r => setTimeout(r, 250));
}
out({ event: 'done' }); process.exit(0);
