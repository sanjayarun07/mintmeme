/** The Meme MCP server over stdio: trading on every chain of the execution server, and the RFQ desk (read-only).
 *  usage: npm run mcp   (env: MEME_API_URL, MEME_API_KEY, MEME_USER_ID?, MEME_PRACTICE_URL?, MEME_PRACTICE_API_KEY?, RFQ_DESK_URL, MCP_ALLOW_TRADES=1 to allow real-funds trades)
 *  Setup and the Claude Desktop / Claude Code config: docs/MCP.md. stdout carries the protocol; logs go to stderr and never contain keys. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callTool, configFromEnv, listTools, redact, secretsFromEnv, type Ctx } from './tools.ts';

const cfg = configFromEnv(process.env), ctx: Ctx = { cfg, fetch, secrets: secretsFromEnv(process.env) };
const server = new Server({ name: 'memedesk', version: '0.1.0' }, {
  capabilities: { tools: {} },
  instructions: 'Meme trading on solana, base, robinhood and bnb (REAL funds) and practice (fake funds), plus the RFQ desk (read-only quotes, gate checks, liquidity). '
    + 'Every trading tool takes `chain`. Tools that spend funds need confirm: true, which you may set only after the user has approved that exact trade in the conversation; '
    + `real-funds trading is ${cfg.allowTrades ? 'ENABLED' : 'disabled'} in this server (MCP_ALLOW_TRADES). Start with meme_chains and rfq_config.`,
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));
server.setRequestHandler(CallToolRequestSchema, async req => callTool(req.params.name, req.params.arguments ?? {}, ctx) as any);
await server.connect(new StdioServerTransport());
console.error(redact(`memedesk MCP server on stdio: ${listTools().length} tools; API ${cfg.apiUrl} (key ${cfg.apiKey ? 'set' : 'NOT set'}), desk ${cfg.deskUrl}, real-funds trades ${cfg.allowTrades ? 'ENABLED' : 'off'}`, ctx.secrets));
