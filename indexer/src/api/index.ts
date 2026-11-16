import { db, publicClients } from 'ponder:api';
import schema from 'ponder:schema';
import { Hono } from 'hono';
import { and, desc, gte, inArray } from 'ponder';

const app = new Hono();
const keys = (process.env.INDEX_CHAINS ?? '').split(',').map(s => s.trim()).filter(Boolean);

/** How far the indexer is behind the chain head, in seconds of chain time (worst chain). null if it cannot be determined. */
async function lagS(): Promise<number | null> {
  try {
    const st: any = await (await fetch(`http://127.0.0.1:${process.env.PORT ?? 42069}/status`)).json(); let worst = 0;
    for (const k of keys) {
      const indexed = st[k]?.block?.timestamp, head = await (publicClients as any)[k].getBlock({ blockTag: 'latest' });
      if (typeof indexed !== 'number') return null; worst = Math.max(worst, Number(head.timestamp) - indexed);
    }
    return Math.max(0, worst);
  } catch { return null; }
}

/** GET /trades?pools=a,b&since=ISO&limit=n  ->  { items:[{pool,chain,side,wallet,usd,tx,t}], health:{lagS} }  (docs/INDEXER_CONTRACT.md) */
app.get('/trades', async c => {
  const pools = (c.req.query('pools') ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean).slice(0, 200);
  if (!pools.length) return c.json({ items: [], health: { lagS: await lagS() } });
  const limit = Math.min(1000, Math.max(1, Number(c.req.query('limit')) || 300)), since = c.req.query('since'), sinceTs = since && Number.isFinite(Date.parse(since)) ? Math.floor(Date.parse(since) / 1000) : null;
  const t = schema.trade, where = sinceTs === null ? inArray(t.pool, pools) : and(inArray(t.pool, pools), gte(t.ts, sinceTs));
  const rows = await db.select().from(t).where(where).orderBy(desc(t.ts)).limit(limit);
  const lag = await lagS();
  return c.json({ items: rows.filter(r => r.usd !== null).map(r => ({ pool: r.pool, chain: r.chain, side: r.side, wallet: r.wallet, usd: r.usd, tx: r.tx, t: new Date(r.ts * 1000).toISOString() })), health: { lagS: lag } });
});
app.get('/lag', async c => c.json({ lagS: await lagS() }));
export default app;
