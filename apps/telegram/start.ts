/** Starts the Telegram bot against REAL Telegram. Shared by `npm run telegram` (apps/telegram/run.ts) and the terminal server, so only ONE process ever polls a token
 *  (two pollers on one token fight each other and Telegram answers 409).
 *  - Always: /link, /unlink, /buy, /sell when `ctxFor` is given (trading is whatever that context allows; the terminal passes its practice account).
 *  - With ALCHEMY_API_KEY: the Buy Bot, the Wallet Bot and the community feed (read-only real data).
 *  Nothing here holds keys or signs. */
import { TelegramBot } from './bot.ts';
import { BuyBot } from './buybot.ts';
import { WalletBot } from './walletbot.ts';
import { startCommunity, realLookups } from './community.ts';
import type { LinkStore } from './linking.ts';
import type { Ctx } from './handler.ts';

export interface StartOpts { token: string; key?: string; arbitrumUrl?: string; linker?: LinkStore; ctxFor?: (userId: string) => Ctx; apiBase?: string; log?: (s: string) => void }
export async function startTelegram(o: StartOpts): Promise<{ bot: TelegramBot; stop: () => void; done: Promise<void> }> {
  const log = o.log ?? console.log, redact = (s: string) => s.split(o.token).join('***');
  const bot = new TelegramBot({ token: o.token, apiBase: o.apiBase, links: new Map(), pollTimeoutS: o.apiBase ? 1 : 25, linker: o.linker, ctxFor: o.ctxFor });
  let stopCommunity = () => {};
  if (o.key) {
    const { makeRpc, checkChainIds, loadRealMarkets } = await import('../../packages/live/src/realmarkets.ts');
    const { Rpc } = await import('../../packages/live/src/rpc.ts');
    const { makeTradeSource } = await import('../../packages/live/src/indexport.ts');
    const { ETH, BSC } = await import('../../packages/live/src/config.ts');
    const { encodeCall, decodeParams } = await import('../../packages/evm/src/index.ts');
    const rpc = await makeRpc(o.key); await checkChainIds(rpc);
    const arb = o.arbitrumUrl ? new Rpc(o.arbitrumUrl, '', fetch, 40) : undefined;   // no default endpoint: Arbitrum balances are "unavailable" unless you provide one
    const wrapped = async (r: typeof rpc.ethereum, router: string) => String(decodeParams(['address'], await r.call<string>('eth_call', [{ to: router, data: encodeCall('WETH()', []) }, 'latest']))[0]).toLowerCase();   // read from the official router on-chain
    const wrappedNative = { ethereum: await wrapped(rpc.ethereum, ETH.uniswapV2Router02.address), bsc: await wrapped(rpc.bsc, BSC.pancakeV2Router.address) };
    const buyBot = new BuyBot({ sink: (g, t) => bot.post(g, t) });
    const walletBot = new WalletBot({ ...realLookups({ rpc: { ethereum: rpc.ethereum, bsc: rpc.bsc, ...(arb ? { arbitrum: arb } : {}) }, wrappedNative }), sink: (u, t) => bot.post(u, t) });
    (bot as any).c.buyBot = buyBot; (bot as any).c.walletBot = walletBot;
    const feed = makeTradeSource({ rpc }, { maxPoolsPerCycle: 4 }); let marketAt = 0, markets: any[] = [];
    stopCommunity = startCommunity({
      buyBot, walletBot,
      tokens: async () => { if (Date.now() - marketAt > 10 * 60_000) { const m = await loadRealMarkets({ rpc }); markets = m.tokens; marketAt = Date.now(); } return markets.filter(t => t.pool).map(t => ({ id: t.id, sym: t.sym, chain: t.chain, contract: t.contract, pool: t.pool, pad: t.pad, chg: null })); },
      pollCycle: t => feed.pollCycle(t),
    }, { everyMs: 60_000, onResult: r => log(`cycle: watching ${r.watched} token(s), polled ${r.polled}, posted ${r.posted}, alerts ${r.alerts}${r.unknownWatched.length ? `, not in the real list: ${r.unknownWatched.length}` : ''}`), onError: e => log('cycle failed: ' + redact(e.message)) });
  }
  let stopping = false; const stop = () => { stopping = true; stopCommunity(); };
  const done = bot.run(() => stopping);
  return { bot, stop, done };
}
