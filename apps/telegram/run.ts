/** Starts the Telegram community bots against REAL Telegram and REAL read-only market data. Needs a bot token from @BotFather in TELEGRAM_BOT_TOKEN, plus ALCHEMY_API_KEY for Ethereum reads.
 *  usage: npm run telegram
 *  Groups the bot is added to can run /buybot (only a group admin, per Telegram, can change it); private chats can run /wallet (read-only balances and price alerts).
 *  This standalone runner has NO trading and no account links. To trade from Telegram, start the terminal instead (npm run web or npm run web:markets) with the same token in .env:
 *  the terminal then runs this same bot itself, plus /link, /buy and /sell. Do not run both with one token (Telegram allows only one poller).
 *  Never run in tests. If no token is set it says so and exits without touching the network. */
import { startTelegram } from './start.ts';

const token = process.env.TELEGRAM_BOT_TOKEN, key = process.env.ALCHEMY_API_KEY;
if (!token) { console.error('TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather, put the token in .env (see .env.example) and run again. Nothing was started.'); process.exit(2); }
if (!key) { console.error('ALCHEMY_API_KEY is not set (needed for read-only Ethereum data). Put it in .env and run again. Nothing was started.'); process.exit(2); }
const t = await startTelegram({ token, key, arbitrumUrl: process.env.ARBITRUM_RPC_URL });
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { t.stop(); setTimeout(() => process.exit(0), 500); });
console.log('Telegram community bots running. Add the bot to a group and send /buybot status, or message it /wallet list. Ctrl+C to stop.');
await t.done;
