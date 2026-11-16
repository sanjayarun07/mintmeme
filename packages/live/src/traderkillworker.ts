/** Worker process for the Trader kill test (traderkill.ts). It runs the real SDK `Trader` over a loopback anvil fork: on a FRESH start it creates a TWAP and a far-away limit buy; on a restart it creates NOTHING and
 *  only calls trader.resume(), so everything it does afterwards comes from the state files. The parent kills it with SIGKILL (or it kills itself right before its first transaction is sent). Local fork, throwaway keys. */
import { Engine, Router, Store, PolicySigner, NATIVE } from '../../core/src/index.ts';
import type { WalletPolicy } from '../../core/src/index.ts';
import { EvmRpcChain, encodeCall, decodeParams } from '../../evm/src/index.ts';
import { Trader } from '../../sdk/src/trader.ts';
import { LocalNode } from './localnode.ts';
import { CastSigner, FaultRpc } from './enginefork.ts';
import { ETH } from './config.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const cfg = JSON.parse(process.env.KW ?? '{}') as { url: string; dir: string; wallets: { address: string; key: string }[]; startAt: number; killBeforeSend?: boolean };
const ETH1 = 10n ** 18n, usdc = ETH.usdc.address.toLowerCase(), router = ETH.uniswapV2Router02.address, factory = ETH.uniswapV2Factory.address;
const out = (o: unknown) => console.log('S ' + JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
const node = new LocalNode(cfg.url), rpc = new FaultRpc(node), signer = new CastSigner();
for (const w of cfg.wallets) signer.add({ address: w.address.toLowerCase(), key: w.key });
const weth = String(decodeParams(['address'], await node.call<string>('eth_call', [{ to: router, data: encodeCall('WETH()', []) }, 'latest']))[0]).toLowerCase();
const pair = String(decodeParams(['address'], await node.call<string>('eth_call', [{ to: factory, data: encodeCall('getPair(address,address)', [weth, usdc]) }, 'latest']))[0]);
const chain = new EvmRpcChain({ id: 'evm-fork', chainId: 1, router, weth, pools: [{ id: 'uni:WETH-USDC', pair }], finalityDepth: 3 }, rpc, signer);
const pol = (): WalletPolicy => ({ userId: 'u1', chains: ['evm-fork'], allowedVenues: ['uniswap-v2'], maxPerTx: { [NATIVE]: 5n * ETH1, [usdc]: 10n ** 12n }, dailyLimit: { [NATIVE]: 100n * ETH1, [usdc]: 10n ** 13n }, destinations: [], deviceSecret: 'd' });
const addrs = cfg.wallets.map(w => w.address.toLowerCase());
const engine = new Engine({ store: Store.open(join(cfg.dir, 'engine.json')), chain, signer: new PolicySigner(new Map(addrs.map(a => [a, 'x'])), new Map(addrs.map(a => [a, pol()]))), router: new Router(chain), platformFeeBps: 0 });
const trader = new Trader({ engine, chain, userId: 'u1', venues: ['uniswap-v2'], persistDir: join(cfg.dir, 'trader') });
await chain.refresh('venues');
const fresh = !existsSync(join(cfg.dir, 'trader', 'trader.json'));
if (cfg.killBeforeSend) rpc.beforeSend = async () => { out({ event: 'about-to-send-then-killed' }); process.kill(process.pid, 'SIGKILL'); };
if (fresh) {
  await trader.limitBuy({ id: 'lb', walletId: addrs[0], token: usdc, amount: ETH1 / 100n, priceE18: trader.spotE18(usdc)! / 2n });
  await trader.twap({ id: 'kt', walletId: addrs[0], token: usdc, side: 'buy', total: 3n * ETH1 / 10n, slices: 3, intervalS: 300, startAt: cfg.startAt, slippageBps: 500 });
} else await trader.resume();
for (;;) {
  await trader.tick();
  const s: any = trader.twapStatus('kt'), pos = trader.positions().find(p => p.token === usdc);
  out({ event: 'tick', fresh, statuses: s.slices.map((x: any) => x.status), reasons: s.slices.map((x: any) => x.reason), due: s.slices.map((x: any) => x.dueAt), time: chain.time, filled: s.filled, done: s.done, received: s.received, order: trader.getOrder('lb')?.status, position: pos?.balance, trades: trader.trades().length });
  if (s.done) break; await new Promise(r => setTimeout(r, 250));
}
out({ event: 'done' }); process.exit(0);
