/** The hosted MCP endpoint: MCP's Streamable HTTP transport in its stateless form (POST JSON-RPC in, one JSON answer out; no sessions, no server-sent stream),
 *  served by the execution server at POST /mcp. No MCP SDK: the protocol here is initialize, ping, tools/list, tools/call and notifications.
 *
 *  Auth: an agent key (Authorization: Bearer mta_...), made by the user in the app. Every tool calls the execution server's own /v1 API with that same key, so the
 *  server enforces what the key may do (reads, market buys and sells) and its caps; this file adds nothing it could get wrong. Plain API keys and sign-in sessions are
 *  refused here: they have no caps, and this endpoint trades without asking. */
import { callTool, listTools, secretsFromEnv, type Config, type Ctx } from './tools.ts';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 256 * 1024;
type Out = { status: number; body?: unknown; headers?: Record<string, string> };
export interface McpRequest {
  method: string; body: AsyncIterable<Buffer | string> | string;
  /** The agent key's record when the bearer is a live agent key; undefined refuses the call. */
  agent?: { label: string; caps: unknown; maxSlippagePct: number; expiresAt: string };
  token?: string; apiUrl: string; fetch?: typeof fetch;
}

const rpcErr = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export async function handleMcp(q: McpRequest): Promise<Out> {
  if (q.method !== 'POST') return { status: 405, headers: { allow: 'POST' }, body: rpcErr(null, -32000, 'This MCP endpoint is stateless: send JSON-RPC with POST.') };
  if (!q.agent || !q.token) return { status: 401, body: rpcErr(null, -32001, 'Send an agent key: Authorization: Bearer mta_... Make one in the app: Account -> AI agent. Plain API keys are not accepted here.') };
  let text = '';
  if (typeof q.body === 'string') text = q.body;
  else { let n = 0; const ch: Buffer[] = []; for await (const c of q.body) { const b = Buffer.isBuffer(c) ? c : Buffer.from(c); n += b.length; if (n > MAX_BODY) return { status: 413, body: rpcErr(null, -32600, 'Request too large.') }; ch.push(b); } text = Buffer.concat(ch).toString('utf8'); }
  let msg: any; try { msg = JSON.parse(text); } catch { return { status: 400, body: rpcErr(null, -32700, 'Parse error: send a JSON-RPC message.') }; }
  const cfg: Config = { apiUrl: q.apiUrl, apiKey: q.token, deskUrl: 'http://127.0.0.1:0', allowTrades: true, autonomous: true, agent: q.agent, timeoutMs: 60_000, deskTimeoutMs: 1 };
  const ctx: Ctx = { cfg, fetch: q.fetch ?? fetch, secrets: [q.token, ...secretsFromEnv(process.env)] };
  if (Array.isArray(msg)) {
    if (!msg.length) return { status: 400, body: rpcErr(null, -32600, 'Empty batch.') };
    const outs = (await Promise.all(msg.map(m => one(m, ctx)))).filter(x => x !== undefined);
    return outs.length ? { status: 200, body: outs } : { status: 202 };
  }
  const out = await one(msg, ctx);
  return out === undefined ? { status: 202 } : { status: 200, body: out };
}

/** One JSON-RPC message. Notifications and responses (no method, or no id) get no answer. */
async function one(m: any, ctx: Ctx): Promise<unknown> {
  if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return rpcErr(m?.id, -32600, 'Invalid JSON-RPC message.');
  if (typeof m.method !== 'string' || m.id === undefined) return undefined;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize': {
      const asked = m.params?.protocolVersion, protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return ok({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'memedesk', title: 'MintMeme trading', version: '0.2.0' },
        instructions: 'Trades REAL funds from the user\'s own wallet (Solana, Base, BNB Chain, Robinhood Chain), signed by their Privy wallet. This agent key may read and make market buys and sells by itself, '
          + 'only within its caps: call meme_chains first to see them (mcp.agent). The server refuses anything over a cap, standing orders, TWAP, bulk and cancels. '
          + 'Check meme_wallet on a chain before trading; quote with meme_quote; check meme_token_safety on Solana before buying an unknown token.' });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: listTools({ hosted: true }) });
    case 'tools/call': {
      const name = m.params?.name; if (typeof name !== 'string') return rpcErr(m.id, -32602, 'tools/call needs params.name.');
      return ok(await callTool(name, m.params?.arguments ?? {}, ctx));
    }
    case 'resources/list': return ok({ resources: [] });
    case 'prompts/list': return ok({ prompts: [] });
    default: return rpcErr(m.id, -32601, `Method not found: ${m.method}`);
  }
}
