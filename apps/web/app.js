/* MINT Trade (/app): multi-chain meme and stock trading on top of the execution server (/v1/<chain>/...) and the page server's read-only market data (/api/sol/market/*).
 * Served by the execution server on this machine (it forwards /app and /api/sol/* to the page server), so /v1 calls are same-origin.
 * Money moves only through the server's own trade routes, signed by Privy inside each chain's policy, after an explicit click; a bridge is signed by the user in Privy.
 * Nothing here holds a private key. The API key is kept in this browser only (session, or this device when the user asks). */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nap = ms => new Promise(r => setTimeout(r, ms));
const store = {
  get(k, d) { try { const v = localStorage.getItem('mint.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mint.' + k, JSON.stringify(v)); } catch { /* private window: settings last for this visit */ } },
};
const CH = {
  solana: { label: 'Solana', short: 'SOL', badge: 'S', native: 'SOL', dec: 9, key: 'sol', presets: ['0.05', '0.1', '0.5', '1'] },
  base: { label: 'Base', short: 'Base', badge: 'B', native: 'ETH', dec: 18, key: 'eth', presets: ['0.001', '0.002', '0.005', '0.01'] },
  robinhood: { label: 'Robinhood', short: 'RH', badge: 'R', native: 'ETH', dec: 18, key: 'eth', presets: ['0.001', '0.002', '0.005', '0.01'] },
  bnb: { label: 'BNB Chain', short: 'BNB', badge: 'N', native: 'BNB', dec: 18, key: 'bnb', presets: ['0.005', '0.01', '0.02', '0.05'] },
};
const IDS = Object.keys(CH);
const S = {
  chain: store.get('chain', 'all'), key: '', natives: {}, watch: store.get('watch', []), quick: store.get('quick', { solana: '0.05', base: '0.001', robinhood: '0.001', bnb: '0.01' }),
  wallets: {}, paused: false, served: [], cfg: null, timers: [], view: null, solWallet: null,
};
try { S.key = sessionStorage.getItem('mint.key') || localStorage.getItem('mint.key') || ''; } catch { /* storage blocked */ }

/* ---------- formatting ---------- */
const sub = n => String(n).split('').map(d => '₀₁₂₃₄₅₆₇₈₉'[+d]).join('');
function usd(n, o = {}) {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n), sign = n < 0 ? '−' : '';
  if (o.compact !== false && a >= 1e9) return sign + '$' + (a / 1e9).toFixed(2) + 'B';
  if (o.compact !== false && a >= 1e6) return sign + '$' + (a / 1e6).toFixed(2) + 'M';
  if (o.compact !== false && a >= 1e4) return sign + '$' + (a / 1e3).toFixed(1) + 'K';
  if (a >= 1) return sign + '$' + a.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: a < 1000 ? 2 : 0 });
  if (a === 0) return '$0';
  if (a >= 0.01) return sign + '$' + a.toFixed(4);
  const s = a.toFixed(20).slice(2), z = s.match(/^0*/)[0].length; // $0.0₅1234
  return sign + '$0.0' + sub(z) + s.slice(z, z + 4);
}
const pct = n => n == null || !Number.isFinite(n) ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(Math.abs(n) >= 100 ? 0 : 2) + '%';
const cls = n => n == null || !Number.isFinite(n) || n === 0 ? '' : n > 0 ? 'up' : 'down';
const amt = (n, dp = 4) => n == null || !Number.isFinite(n) ? '—' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'K' : n.toLocaleString('en-US', { maximumFractionDigits: n >= 1 ? 2 : dp });
function age(iso) { const t = Date.parse(iso ?? ''); if (!t) return ''; const s = Math.max(0, (Date.now() - t) / 1000); return s < 3600 ? Math.max(1, Math.round(s / 60)) + 'm' : s < 86400 ? Math.round(s / 3600) + 'h' : s < 86400 * 60 ? Math.round(s / 86400) + 'd' : Math.round(s / 86400 / 30) + 'mo'; }
const short = a => a ? a.slice(0, 4) + '…' + a.slice(-4) : '';
const badge = c => `<span class="cb ${esc(c)}" title="${esc(CH[c]?.label ?? c)}">${esc(CH[c]?.badge ?? '?')}</span>`;
const icon = (r, size = '') => `<span class="ic">${r.icon ? `<img src="${esc(r.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ph-ic',textContent:${esc(JSON.stringify((r.symbol || '?').slice(0, 2)))}}))">` : `<span class="ph-ic">${esc((r.symbol || '?').slice(0, 2))}</span>`}${badge(r.chain)}</span>`;
/** "1.5" plain to raw base units (BigInt string), refusing anything that is not a plain positive number. */
function toRaw(x, dec) { const s = String(x ?? '').trim(); if (!/^\d+(\.\d+)?$/.test(s)) return null; const [i, f = ''] = s.split('.'); return (BigInt(i) * 10n ** BigInt(dec) + BigInt((f + '0'.repeat(dec)).slice(0, dec))).toString(); }
const fromRaw = (raw, dec) => raw == null || dec == null ? null : Number(BigInt(raw)) / 10 ** dec;

/* ---------- toasts, dialog ---------- */
function toast(kind, title, body = '') { const t = document.createElement('div'); t.className = 'toast ' + kind; t.innerHTML = `<b>${esc(title)}</b>${body ? `<span>${esc(body)}</span>` : ''}`; t.onclick = () => t.remove(); $('#toasts').append(t); setTimeout(() => t.remove(), kind === 'err' ? 12000 : 6000); }
function dialog(title, html, mount) {
  const d = $('#dlg'); d.innerHTML = `<header><h2>${esc(title)}</h2><button class="btn ghost sm" value="close" aria-label="Close">Close</button></header><div class="body">${html}</div>`;
  $('header button', d).onclick = () => d.close(); d.showModal(); mount?.(d); return d;
}
const note = (kind, title, body = '') => `<div class="note ${kind}"><div><b>${esc(title)}</b>${body ? ' ' + body : ''}</div></div>`;

/* ---------- data ---------- */
async function market(path, body) {
  const r = await fetch('/api/sol/market/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const j = await r.json().catch(() => ({})); if (!r.ok || j.ok === false) throw new Error(j.why || 'Market data is unavailable right now.'); return j;
}
async function page(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const j = await r.json().catch(() => ({})); if (!r.ok || j.ok === false) throw new Error([j.why, j.fix && j.fix !== 'Nothing was signed or sent.' ? j.fix : ''].filter(Boolean).join(' ') || 'HTTP ' + r.status); return j;
}
class ApiError extends Error { constructor(m, code, status) { super(m); this.code = code; this.status = status; } }
async function v1(chain, method, path, body, headers = {}) {
  if (!S.key) throw new ApiError('Add your API key in Account first.', 'no_key', 401);
  // routes are written as the server documents them (/v1/wallet); on a multi-chain server they live under /v1/<chain>/wallet
  const r = await fetch(`/v1/${chain}${path.replace(/^\/v1\//, '/')}`, { method, headers: { authorization: 'Bearer ' + S.key, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = j.error || {}; throw new ApiError([e.message, e.fix].filter(Boolean).join(' ') || 'The server answered HTTP ' + r.status + '.', e.code, r.status); }
  return j;
}
const meta = {}; // `${chain}:${addr}` -> { symbol, decimals, price, icon }
async function loadMeta(chain, tokens) {
  const need = [...new Set(tokens)].filter(t => !meta[chain + ':' + t.toLowerCase()]);
  for (let i = 0; i < need.length; i += 30) {
    try { const r = await market('meta', { chain, tokens: need.slice(i, i + 30) }); for (const [k, v] of Object.entries(r.tokens)) meta[chain + ':' + k.toLowerCase()] = v; } catch { /* shown as unknown */ }
  }
  return t => meta[chain + ':' + String(t).toLowerCase()] || {};
}
async function refreshNatives() { try { S.natives = (await market('natives')).prices; } catch { /* keep last */ } renderPx(); }

/* ---------- chrome: chain switcher, status bar, search ---------- */
function renderChains() {
  const el = $('#chains'), opts = [['all', 'All']].concat(IDS.map(c => [c, CH[c].short]));
  el.innerHTML = opts.map(([c, l]) => `<button type="button" role="radio" aria-checked="${S.chain === c}" data-c="${c}">${c === 'all' ? '' : badge(c)}${esc(l)}</button>`).join('');
  $$('button', el).forEach(b => b.onclick = () => { S.chain = b.dataset.c; store.set('chain', S.chain); renderChains(); if (S.view === 'discover') route(); });
}
function renderPx() {
  const p = S.natives; $('#px').innerHTML = [['SOL', p.solana], ['ETH', p.base], ['BNB', p.bnb]].filter(([, v]) => v).map(([s, v]) => `<span><span class="faint">${s}</span> ${usd(v, { compact: false })}</span>`).join('');
}
function setLive(ok, text) { const l = $('#live'); l.className = 'live ' + (ok === true ? 'ok' : ok === false ? 'bad' : ''); $('span', l).textContent = text; }
function renderWalletBtn() {
  const b = $('#walletbtn'), linked = IDS.filter(c => S.wallets[c]?.linked), active = IDS.filter(c => S.wallets[c]?.active);
  if (!S.key) { b.className = 'wallet'; b.textContent = 'Set up trading'; return; }
  const addr = S.wallets.solana?.address || IDS.map(c => S.wallets[c]?.address).find(Boolean);
  b.className = 'wallet ready' + (active.length < linked.length || !linked.length ? ' warn' : '');
  b.innerHTML = `<span class="dot"></span>${linked.length ? esc(short(addr)) + ` <span class="faint">${active.length}/${IDS.length} chains</span>` : 'Link wallet'}`;
}
$('#walletbtn').onclick = () => { location.hash = '#/setup'; };
let qTimer, qSeq = 0;
$('#q').addEventListener('input', () => {
  clearTimeout(qTimer); const v = $('#q').value.trim(), box = $('#qres');
  if (v.length < 2) { box.hidden = true; return; }
  qTimer = setTimeout(async () => {
    const seq = ++qSeq; box.hidden = false; box.innerHTML = '<div class="pad muted">Searching…</div>';
    try {
      const { rows } = await market('search', { q: v }); if (seq !== qSeq) return;
      box.innerHTML = rows.length ? rows.map((r, i) => `<a role="option" href="#/t/${r.chain}/${esc(r.address)}" aria-selected="${i === 0}"><span class="tok">${icon(r)}</span><span><b>${esc(r.symbol)}</b> <span class="muted">${esc(r.name)}</span><br><small class="faint">${esc(CH[r.chain].label)} · liq ${usd(r.liquidity)}</small></span><span class="num">${usd(r.price)}<br><small class="${cls(r.change24h)}">${pct(r.change24h)}</small></span></a>`).join('') : '<div class="pad muted">No token found on Solana, Base, Robinhood Chain or BNB Chain.</div>';
      $$('a', box).forEach(a => a.onclick = () => { box.hidden = true; $('#q').value = ''; });
    } catch (e) { box.innerHTML = `<div class="pad muted">${esc(e.message)}</div>`; }
  }, 250);
});
$('#q').addEventListener('keydown', e => { if (e.key === 'Enter') { const a = $('#qres a'); if (a) { location.hash = a.getAttribute('href'); $('#qres').hidden = true; $('#q').value = ''; } } if (e.key === 'Escape') { $('#qres').hidden = true; $('#q').blur(); } });
document.addEventListener('click', e => { if (!e.target.closest('.search')) $('#qres').hidden = true; });
document.addEventListener('keydown', e => { if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) { e.preventDefault(); $('#q').focus(); } });
const theme = () => { const t = store.get('theme', null); if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
$('#themebtn').onclick = () => { const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'); store.set('theme', cur === 'dark' ? 'light' : 'dark'); theme(); };
theme();
$('#pausebtn').onclick = async () => {
  const on = !S.paused, chains = IDS.filter(c => S.wallets[c]?.linked);
  if (!chains.length) { toast('warn', 'Nothing to pause', 'No chain is linked yet.'); return; }
  const r = await Promise.allSettled(chains.map(c => v1(c, 'POST', on ? '/v1/entries/pause' : '/v1/entries/resume', {})));
  const bad = r.filter(x => x.status === 'rejected'); if (bad.length) { toast('err', 'Not changed on every chain', bad[0].reason.message); return; }
  S.paused = on; renderPause(); toast(on ? 'warn' : 'ok', on ? 'New buys paused' : 'Buys resumed', on ? 'Sells and stop losses keep working on every chain.' : '');
};
function renderPause() { const b = $('#pausebtn'); b.setAttribute('aria-pressed', String(S.paused)); b.textContent = S.paused ? 'Buys paused · resume' : 'Pause new buys'; }

/* ---------- account state ---------- */
async function loadAccount() {
  if (!S.key) { S.wallets = {}; renderWalletBtn(); setLive(null, 'Browsing · add your API key to trade'); return; }
  await Promise.all(S.served.map(async c => {
    try { S.wallets[c] = await v1(c, 'GET', '/v1/wallet'); } catch (e) { S.wallets[c] = { linked: false, active: false, why: e.message, error: e.status }; }
  }));
  try { const o = await v1(S.served[0] || 'solana', 'GET', '/v1/overview'); S.paused = !!o.entriesPaused; } catch { /* stays as shown */ }
  renderWalletBtn(); renderPause();
  const bad = Object.values(S.wallets).find(w => w.error === 401);
  setLive(!bad, bad ? 'API key refused' : 'Server connected');
}

/* ---------- live events (fetch stream: EventSource cannot send the key) ---------- */
const streams = {};
function startStreams() {
  for (const c of S.served) {
    if (streams[c] || !S.key || !S.wallets[c]?.linked) continue;
    const ctl = new AbortController(); streams[c] = ctl;
    (async () => {
      for (let attempt = 0; !ctl.signal.aborted; attempt++) {
        try {
          const r = await fetch(`/v1/${c}/events`, { headers: { authorization: 'Bearer ' + S.key, accept: 'text/event-stream' }, signal: ctl.signal });
          if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
          setLive(true, 'Live'); attempt = 0;
          const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
          for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true });
            let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n'); if (data) onEvent(c, data); } }
        } catch (e) { if (ctl.signal.aborted) return; setLive(false, 'Reconnecting'); }
        await nap(Math.min(30000, 1000 * 2 ** attempt));
      }
    })();
  }
}
function onEvent(chain, data) {
  let ev; try { ev = JSON.parse(data); } catch { return; }
  const t = ev.type || ev.event, label = CH[chain].label;
  if (t === 'alert') toast('warn', `Price alert on ${label}`, `${short(ev.token)} crossed ${ev.direction} your level.`);
  else if (t === 'order' && /filled|failed|triggered/.test(ev.status || ev.state || '')) toast(ev.status === 'failed' ? 'err' : 'ok', `Order ${ev.status || ev.state} on ${label}`, ev.reason || ev.failure || '');
  else if (t === 'trade' && ev.origin && ev.origin !== 'manual' && /finalized|failed/.test(ev.state || '')) toast(ev.state === 'failed' ? 'err' : 'ok', `${ev.origin} trade ${ev.state} on ${label}`, ev.failure || '');
  else if (t === 'error') toast('err', `Server error on ${label}`, ev.message || '');
  if (S.view === 'portfolio' && /trade|order/.test(t)) { clearTimeout(S.pRefresh); S.pRefresh = setTimeout(() => route(), 1500); }
}

/* ---------- trading actions ---------- */
const needSetup = chain => { if (!S.key) return 'Add your API key in Account to trade.'; const w = S.wallets[chain]; if (!w?.linked) return `Link your wallet on ${CH[chain].label} in Account first.`; if (!w.active) return w.why || `Trading is not active on ${CH[chain].label}.`; return null; };
async function runTrade(chain, path, body, onStep) {
  const key = 'app-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  let t = await v1(chain, 'POST', path, body, { 'idempotency-key': key });
  for (let i = 0; i < 80 && !['finalized', 'failed', 'expired'].includes(t.state); i++) { onStep?.(t.state); await nap(1500); t = await v1(chain, 'POST', `/v1/trades/${encodeURIComponent(t.key)}/advance`, {}); }
  return t;
}
const explorer = (chain, tx) => !tx ? '' : chain === 'solana' ? `https://solscan.io/tx/${tx}` : chain === 'base' ? `https://basescan.org/tx/${tx}` : chain === 'bnb' ? `https://bscscan.com/tx/${tx}` : `https://explorer.chain.robinhood.com/tx/${tx}`;
/** On Robinhood or BNB, bring the missing coin from Base first (the user approves the Relay deposit in Privy). Returns false if the user cancels. */
async function ensureFunds(chain, spend, out) {
  if (chain === 'solana' || chain === 'base') return true;
  const P = window.MintPrivy, a = P?.evm?.address?.(); if (!a) return true; // not logged in to Privy here: the server's own check reports a shortfall
  const p = await page('/api/sol/evm/balances', { address: a, to: chain, spend });
  if (p.need === null || p.needWei === '0') return true;
  const q = await page('/api/sol/bridge/quote', { address: a, from: 'base', to: chain, receiveWei: p.needWei });
  const have = p.chains.find(c => c.chain === chain)?.amount ?? '0', onBase = p.chains.find(c => c.chain === 'base')?.amount ?? '?', N = CH[chain].native;
  const go = await new Promise(res => {
    out.innerHTML = note('warn', `Bring ${N} from Base first`, `You have ${esc(have)} ${N} on ${esc(CH[chain].label)}; this buy needs ${esc(spend)} plus about ${esc(p.reserve)} for gas. Relay brings ${esc(q.receive)} ${esc(q.receiveSymbol)} to the same wallet for ${esc(q.pay)} ETH on Base (you have ${esc(onBase)}), fees about $${esc(String(q.feeUsd))}.`) +
      `<div class="chips" style="margin-top:8px"><button class="btn primary sm" data-go>Approve in Privy and buy</button><button class="btn ghost sm" data-no>Cancel</button></div>`;
    $('[data-go]', out).onclick = () => res(true); $('[data-no]', out).onclick = () => res(false);
  });
  if (!go) { out.innerHTML = note('', 'Cancelled', 'Nothing was signed or sent.'); return false; }
  out.innerHTML = note('', 'Waiting for you in Privy', 'Approve the transfer of ' + esc(q.pay) + ' ETH on Base.');
  const hash = await P.evm.send(q.tx, { title: 'Bring ' + q.receiveSymbol + ' to ' + CH[chain].label, description: `Sends ${q.pay} ETH on Base to Relay, which delivers ${q.receive} ${q.receiveSymbol} to this same wallet.` });
  out.innerHTML = note('', 'Moving your ' + N, `Sent on Base (<a href="https://basescan.org/tx/${esc(hash)}" target="_blank" rel="noopener noreferrer">view</a>). Waiting for Relay…`);
  for (let i = 0; ; i++) { await nap(2000); const st = await page('/api/sol/bridge/status', { requestId: q.requestId }); if (st.state === 'done') break; if (st.state === 'failed') throw new Error(st.why + ' No buy was made.'); if (i > 90) throw new Error('Relay has not delivered after 3 minutes. No buy was made; try again once it arrives.'); }
  for (let i = 0; i < 20; i++) { const b = await page('/api/sol/evm/balances', { address: a, to: chain, spend }); if (b.needWei === '0') return true; await nap(1500); }
  throw new Error('Relay delivered, but the balance has not caught up yet. Press buy again in a few seconds. No buy was made.');
}
/** Market buy with a plain confirmation dialog: quote, then send, then follow it to the chain. */
async function quickBuy(row, spend) {
  const chain = row.chain, C = CH[chain], why = needSetup(chain);
  if (why) { toast('warn', 'Not ready to trade', why); return; }
  const raw = toRaw(spend, C.dec); if (!raw || raw === '0') { toast('warn', 'Set a buy size', 'Type an amount like ' + C.presets[0] + '.'); return; }
  const m = (await loadMeta(chain, [row.address]))(row.address);
  dialog(`Buy ${row.symbol}`, `<div class="sum"><div><span>Pay</span><b>${esc(spend)} ${C.native}</b></div><div><span>On</span><b>${badge(chain)} ${esc(C.label)}</b></div><div><span>You get about</span><b id="dq">Getting a quote…</b></div><div><span>Minimum after slippage (3%)</span><b id="dmin">—</b></div><div><span>Route</span><b id="dv">—</b></div></div><div id="dout"></div><button class="btn primary block" id="dgo" disabled>Buy ${esc(row.symbol)}</button><p class="faint" style="margin:0;font-size:12.5px">Real funds. The server signs inside your ${esc(C.label)} limits.</p>`, async d => {
    try {
      const q = await v1(chain, 'POST', '/v1/quote', { side: 'buy', token: row.address, amount: raw });
      const dec = m.decimals; $('#dq', d).textContent = dec != null ? amt(fromRaw(q.amountOut, dec)) + ' ' + row.symbol : q.amountOut + ' units';
      $('#dmin', d).textContent = dec != null ? amt(fromRaw(q.minOut, dec)) + ' ' + row.symbol : '—'; $('#dv', d).textContent = String(q.venue || '').split(':')[0] || '—';
      $('#dgo', d).disabled = false;
    } catch (e) { $('#dq', d).textContent = 'No quote'; $('#dout', d).innerHTML = note('err', 'Cannot buy right now', esc(e.message)); if (e.code !== 'insufficient_funds') return; $('#dgo', d).disabled = false; }
    $('#dgo', d).onclick = async () => {
      const b = $('#dgo', d), out = $('#dout', d); b.disabled = true;
      try {
        if (!(await ensureFunds(chain, spend, out))) { b.disabled = false; return; }
        out.innerHTML = note('', 'Sending', 'The server builds the trade, Privy signs it, the server sends it.');
        const t = await runTrade(chain, '/v1/trades/buy', { token: row.address, [C.key]: spend, slippagePct: 3 }, s => { out.innerHTML = note('', 'Sending', 'State: ' + esc(s)); });
        const sent = (t.history || []).some(x => x.state === 'submitted');
        out.innerHTML = t.state === 'finalized' ? note('ok', 'Bought', `<a href="${esc(explorer(chain, t.txHash))}" target="_blank" rel="noopener noreferrer">View transaction</a>`) : note('err', 'Trade ' + esc(t.state), (sent ? 'It was sent. ' : 'Nothing was sent. ') + esc(t.failure || ''));
        if (t.state === 'finalized') { toast('ok', `Bought ${row.symbol}`, `${spend} ${C.native} on ${C.label}`); b.textContent = 'Done'; }
        else b.disabled = false;
      } catch (e) { out.innerHTML = note('err', 'Not done', esc(e.message)); b.disabled = false; }
    };
  });
}

/* ---------- views ---------- */
const V = {};
function clearTimers() { S.timers.forEach(clearInterval); S.timers = []; (S.cleanup || []).forEach(f => f()); S.cleanup = []; if (S.chart) { try { S.chart.remove(); } catch { /* gone */ } S.chart = null; } }
function every(ms, fn) { S.timers.push(setInterval(fn, ms)); }
function route() {
  clearTimers();
  const h = location.hash.replace(/^#\/?/, ''), [a, b, c] = h.split('/');
  const view = a === 't' && CH[b] && c ? 'token' : ({ '': 'discover', portfolio: 'portfolio', rfq: 'rfq', copy: 'copy', alerts: 'alerts', setup: 'setup' })[a] ?? 'discover';
  S.view = view;
  $$('[data-nav]').forEach(n => { if (n.dataset.nav === (view === 'token' ? 'discover' : view)) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current'); });
  const main = $('#main'); main.innerHTML = '';
  V[view](main, b, c);
  document.title = ({ discover: 'Discover', token: 'Token', portfolio: 'Portfolio', rfq: 'RFQ quotes', copy: 'Copy trading', alerts: 'Alerts', setup: 'Account' })[view] + ' · MINT Trade';
}
window.addEventListener('hashchange', route);

/* Discover */
V.discover = (main) => {
  const tab = store.get('dtab', 'trending'), quick = S.chain === 'all' ? null : S.chain;
  main.innerHTML = `<div class="page">
    <div class="ph"><div><h1>${S.chain === 'all' ? 'Every chain' : esc(CH[S.chain].label)}</h1><p>Trending and new tokens on Solana, Base, Robinhood Chain and BNB Chain. Click a row for the chart and full trading.</p></div></div>
    <div class="disc-tools"><div class="seg" role="tablist" id="dtabs">${[['trending', 'Trending'], ['new', 'New'], ['stocks', 'Stocks'], ['watch', 'Watchlist']].map(([k, l]) => `<button role="tab" aria-selected="${tab === k}" data-t="${k}">${l}</button>`).join('')}</div><span class="grow"></span>
      ${quick ? `<label class="quick">Quick buy <span class="input"><input id="qsize" inputmode="decimal" value="${esc(S.quick[quick])}" aria-label="Quick buy size"><span class="unit">${CH[quick].native}</span></span></label>` : '<span class="quick faint">Pick one chain above to set its quick-buy size.</span>'}</div>
    <div class="card"><div class="filters" id="dfilt"></div><div id="dnote"></div><div class="tbl-wrap"><table class="tbl"><thead><tr><th style="width:28px"></th><th>Token</th>${SORTS.map(([k, l, hide]) => `<th class="num${hide ? ' hide-s' : ''}"><button class="sort" data-sort="${k}">${l}<i aria-hidden="true"></i></button></th>`).join('')}<th class="num"></th></tr></thead><tbody id="drows">${skeletonRows(10)}</tbody></table></div></div></div>`;
  $$('#dtabs button').forEach(b => b.onclick = () => { store.set('dtab', b.dataset.t); route(); });
  // sorting (click a header: high to low, again: low to high, again: back to the source order) and filters, kept in this browser
  let rows = [], sort = store.get('dsort', null), filt = store.get('dfilt', {});
  const sortHeads = () => $$('[data-sort]').forEach(b => { const on = sort?.k === b.dataset.sort; b.setAttribute('aria-sort', on ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'); $('i', b).textContent = on ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''; });
  $$('[data-sort]').forEach(b => b.onclick = () => { const k = b.dataset.sort; sort = sort?.k !== k ? { k, dir: -1 } : sort.dir < 0 ? { k, dir: 1 } : null; store.set('dsort', sort); sortHeads(); paint(); });
  const drawFilters = () => {
    const n = FILTERS.filter(([k]) => filt[k] != null && filt[k] !== '').length;
    $('#dfilt').innerHTML = `<div class="frow"><button class="chip" id="fopen" aria-expanded="${!!filt.open}">Filters${n ? ` · ${n}` : ''}</button>${n ? '<button class="chip" id="fclear">Clear</button>' : ''}<span class="faint" id="fcount"></span></div>
      ${filt.open ? `<div class="fgrid">${FILTERS.map(([k, l, ph]) => `<label class="field"><span>${l}</span><span class="input"><input data-f="${k}" inputmode="decimal" placeholder="${ph}" value="${esc(filt[k] ?? '')}"></span></label>`).join('')}</div>` : ''}`;
    $('#fopen').onclick = () => { filt.open = !filt.open; store.set('dfilt', filt); drawFilters(); };
    if ($('#fclear')) $('#fclear').onclick = () => { filt = { open: filt.open }; store.set('dfilt', filt); drawFilters(); paint(); };
    $$('[data-f]').forEach(i => i.oninput = () => { filt[i.dataset.f] = i.value.trim(); store.set('dfilt', filt); clearTimeout(S.ft); S.ft = setTimeout(() => { paint(); const c = FILTERS.filter(([k]) => filt[k]).length; $('#fopen').textContent = 'Filters' + (c ? ` · ${c}` : ''); }, 200); });
  };
  const paint = () => {
    const tb = $('#drows'); if (!tb) return;
    const shown = applyFilters(rows, filt); if (sort) shown.sort((a, b) => cmp(sortVal(a, sort.k), sortVal(b, sort.k), sort.dir));
    $('#fcount').textContent = rows.length ? (shown.length === rows.length ? `${rows.length} tokens` : `${shown.length} of ${rows.length} tokens`) : '';
    tb.innerHTML = shown.length ? shown.map(rowHtml).join('') : rows.length ? `<tr><td colspan="10"><div class="empty"><b>No token matches these filters</b>Loosen a filter or press Clear.</div></td></tr>` : `<tr><td colspan="10"><div class="empty"><b>Nothing here right now</b>Try another chain or tab.</div></td></tr>`;
    wireRows(tb, shown);
  };
  drawFilters(); sortHeads();
  if ($('#qsize')) $('#qsize').onchange = e => { S.quick[quick] = e.target.value.trim(); store.set('quick', S.quick); };
  const load = async () => {
    const tb = $('#drows'); if (!tb) return; let extra = '';
    try {
      if (tab === 'watch') {
        rows = S.watch.filter(w => S.chain === 'all' || w.chain === S.chain);
        if (!rows.length) { tb.innerHTML = `<tr><td colspan="10"><div class="empty"><b>No tokens on your watchlist yet</b>Tap the star on any row to keep it here.</div></td></tr>`; return; }
        rows = rows.map(r => ({ ...r }));
        await Promise.all(IDS.map(async c => { const ws = rows.filter(r => r.chain === c); if (!ws.length) return;
          try { const m = (await market('rows', { chain: c, tokens: ws.map(r => r.address) })).rows; ws.forEach(r => Object.assign(r, m[r.address.toLowerCase()] ?? {}, { chain: c })); } catch { /* keep what was saved */ } }));
      } else if (tab === 'stocks') {
        if (S.chain !== 'all' && S.chain !== 'solana') { tb.innerHTML = `<tr><td colspan="10"><div class="empty"><b>Stocks are listed for Solana here</b>Robinhood Chain and Base stock tokens trade from their token page: search a ticker such as TSLA.</div></td></tr>`; return; }
        if (!S.key) { tb.innerHTML = `<tr><td colspan="10"><div class="empty"><b>Add your API key to see stocks</b>The verified stock list comes from your trading server. <a class="btn sm" href="#/setup">Open Account</a></div></td></tr>`; return; }
        const s = await v1('solana', 'GET', '/v1/stocks?limit=60'); const list = (s.stocks || []).filter(x => x.tradable);
        // the server's list says which stocks are verified and tradable; the market numbers (change, volume, market cap, buys and sells) come from DexScreener
        let mk = {}; try { mk = (await market('rows', { chain: 'solana', tokens: list.map(x => x.mint) })).rows; } catch { /* show the list without them */ }
        rows = list.map(x => { const m = mk[x.mint.toLowerCase()] || {}; return { chain: 'solana', address: x.mint, symbol: x.symbol, name: x.issuer, icon: m.icon ?? null, price: m.price ?? null, change1h: m.change1h ?? null, change24h: m.change24h ?? null, mcap: m.mcap ?? null, liquidity: m.liquidity ?? x.liquidityUsd ?? null, volume24h: m.volume24h ?? null, buys24h: m.buys24h ?? null, sells24h: m.sells24h ?? null, createdAt: null, holders: null }; })
          .sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0));
        if (!rows.some(r => r.price != null)) { const get = await loadMeta('solana', list.map(x => x.mint)); rows.forEach(r => { const g = get(r.address); r.price = g.price ?? null; r.icon = r.icon ?? g.icon ?? null; }); }
        extra = note('', 'Tokenized stocks', esc(s.note || ''));
      } else {
        const r = await market('list', { chain: S.chain, tab }); rows = r.rows;
        if (r.unavailable?.length) extra = note('warn', 'Some chains did not answer', r.unavailable.map(u => esc(CH[u.chain].label)).join(', ') + '. Showing the rest.');
        else if (r.stale) extra = note('', 'Showing data from a minute ago', 'The data source is busy.');
      }
      $('#dnote').innerHTML = extra ? `<div class="pad" style="padding-bottom:0">${extra}</div>` : '';
      paint();
    } catch (e) { tb.innerHTML = `<tr><td colspan="10"><div class="empty"><b>Could not load tokens</b>${esc(e.message)}</div></td></tr>`; }
  };
  load(); if (tab === 'trending' || tab === 'new') every(30000, load);
};
/* sort and filter for the Discover table */
const SORTS = [['price', 'Price', false], ['change1h', '1h', true], ['change24h', '24h', false], ['mcap', 'Market cap', true], ['liquidity', 'Liquidity', true], ['volume24h', 'Volume 24h', true], ['flow', 'Buys / sells', true]];
const FILTERS = [['minMcap', 'Min market cap ($)', '100k'], ['maxMcap', 'Max market cap ($)', '50m'], ['minLiq', 'Min liquidity ($)', '25k'], ['minVol', 'Min volume 24h ($)', '50k'],
  ['min1h', 'Min 1h change (%)', '-5'], ['min24h', 'Min 24h change (%)', '0'], ['max24h', 'Max 24h change (%)', '500'], ['minBuys', 'Min buys share (%)', '55']];
/** "25k", "1.5m", "2b", "-5" to a number; anything else is no filter. */
const parseN = s => { const m = /^(-?\d+(?:\.\d+)?)\s*([kmb])?$/i.exec(String(s ?? '').trim()); return m ? Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1) : null; };
const buyShare = r => r.buys24h != null && r.sells24h != null && r.buys24h + r.sells24h > 0 ? r.buys24h / (r.buys24h + r.sells24h) * 100 : null;
const sortVal = (r, k) => k === 'flow' ? buyShare(r) : r[k];
/** Missing values always sort last, whichever the direction. */
const cmp = (a, b, dir) => a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : (a - b) * dir;
function applyFilters(rows, f) {
  const lim = Object.fromEntries(FILTERS.map(([k]) => [k, parseN(f[k])]));
  const min = (v, x) => x == null || (v != null && v >= x), max = (v, x) => x == null || (v != null && v <= x);
  return rows.filter(r => min(r.mcap, lim.minMcap) && max(r.mcap, lim.maxMcap) && min(r.liquidity, lim.minLiq) && min(r.volume24h, lim.minVol) && min(r.change1h, lim.min1h) && min(r.change24h, lim.min24h) && max(r.change24h, lim.max24h) && min(buyShare(r), lim.minBuys));
}
const skeletonRows = n => Array.from({ length: n }, () => `<tr><td></td><td><span class="skel" style="width:140px"></span></td>${'<td><span class="skel" style="width:60px;margin-left:auto"></span></td>'.repeat(8)}</tr>`).join('');
const watched = r => S.watch.some(w => w.chain === r.chain && w.address.toLowerCase() === r.address.toLowerCase());
function rowHtml(r, i) {
  const fl = r.buys24h != null && r.sells24h != null && r.buys24h + r.sells24h > 0 ? r.buys24h / (r.buys24h + r.sells24h) : null;
  return `<tr data-i="${i}" tabindex="0">
    <td><button class="star" data-star aria-pressed="${watched(r)}" aria-label="Watch ${esc(r.symbol)}"><svg viewBox="0 0 24 24" width="15" height="15"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" fill="${watched(r) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button></td>
    <td><div class="tok">${icon(r)}<div><b>${esc(r.symbol)}</b><small>${esc(r.name).slice(0, 26)}${r.createdAt ? ` <span>· ${age(r.createdAt)}</span>` : ''}${r.holders ? ` <span>· ${amt(r.holders)} holders</span>` : ''}</small></div></div></td>
    <td class="num">${usd(r.price)}</td><td class="num hide-s ${cls(r.change1h)}">${pct(r.change1h)}</td><td class="num ${cls(r.change24h)}">${pct(r.change24h)}</td>
    <td class="num hide-s">${usd(r.mcap)}</td><td class="num hide-s">${usd(r.liquidity)}</td><td class="num hide-s">${usd(r.volume24h)}</td>
    <td class="num hide-s">${fl == null ? '<span class="faint">—</span>' : `<div class="flow" title="${amt(r.buys24h)} buys, ${amt(r.sells24h)} sells"><i style="width:${(fl * 100).toFixed(0)}%"></i></div><span class="flow-n">${amt(r.buys24h)} / ${amt(r.sells24h)}</span>`}</td>
    <td class="num"><button class="qb" data-buy>Buy ${esc(S.chain === 'all' ? '' : S.quick[r.chain] + ' ' + CH[r.chain].native)}</button></td></tr>`;
}
function wireRows(tb, rows) {
  $$('tr[data-i]', tb).forEach(tr => {
    const r = rows[+tr.dataset.i], open = () => { location.hash = `#/t/${r.chain}/${r.address}`; };
    tr.onclick = e => { if (e.target.closest('button')) return; open(); };
    tr.onkeydown = e => { if (e.key === 'Enter') open(); };
    $('[data-star]', tr).onclick = () => { if (watched(r)) S.watch = S.watch.filter(w => !(w.chain === r.chain && w.address.toLowerCase() === r.address.toLowerCase())); else S.watch.push({ chain: r.chain, address: r.address, symbol: r.symbol, name: r.name, icon: r.icon }); store.set('watch', S.watch); const b = $('[data-star]', tr); b.setAttribute('aria-pressed', String(watched(r))); $('path', b).setAttribute('fill', watched(r) ? 'currentColor' : 'none'); };
    $('[data-buy]', tr).onclick = () => quickBuy(r, S.chain === 'all' ? S.quick[r.chain] : ($('#qsize')?.value.trim() || S.quick[r.chain]));
  });
}

/* Token page */
V.token = (main, chain, address) => {
  const C = CH[chain];
  main.innerHTML = `<div class="page tp"><div class="stack" style="display:grid;gap:16px;min-width:0">
    <div class="card"><div class="th" id="thead"><span class="skel" style="width:220px;height:28px"></span></div>
      <div class="chart-box"><div class="chart-tools"><div class="seg" id="tfs">${['1m', '5m', '15m', '1h', '4h', '1d'].map(t => `<button data-tf="${t}" aria-selected="${t === store.get('tf', '15m')}">${t}</button>`).join('')}</div><span class="grow" style="flex:1"></span><span class="faint" id="chartsrc" style="font-size:12px"></span></div><div class="chart" id="chart"></div></div></div>
    <div class="card"><div class="tabs" role="tablist" id="ttabs"><button aria-selected="true" data-x="safety">Safety</button><button aria-selected="false" data-x="pools">Markets</button><button aria-selected="false" data-x="orders">My orders</button></div><div id="tx"></div></div>
  </div><aside class="card trade" id="trade" aria-label="Trade"></aside></div>`;
  let info = null, pos = null, decimals = null;
  const head = () => {
    const t = info.token;
    $('#thead').innerHTML = `<div class="tok">${icon(t)}<div><b>${esc(t.symbol)}</b><small>${esc(t.name)} · ${esc(C.label)} · <button class="copy-addr" id="cpa" title="Copy address">${esc(short(address))}</button></small></div></div>
      <div><div class="price">${usd(t.price)}</div><div class="${cls(t.change24h)}" style="font-weight:600">${pct(t.change24h)} <span class="faint" style="font-weight:400">24h</span></div></div>
      <div class="stats">${[['Market cap', usd(t.mcap)], ['Liquidity', usd(t.liquidity)], ['Volume 24h', usd(t.volume24h)], ['Buys / sells', t.buys24h != null ? amt(t.buys24h) + ' / ' + amt(t.sells24h) : '—'], ...(t.holders ? [['Holders', amt(t.holders)]] : []), ['Age', age(t.createdAt) || '—']].map(([k, v]) => `<div class="stat"><small>${k}</small><b>${v}</b></div>`).join('')}
      <button class="star" id="tstar" aria-pressed="${watched(t)}" aria-label="Watch">${watched(t) ? '★' : '☆'}</button></div>`;
    $('#cpa').onclick = () => { navigator.clipboard?.writeText(address).then(() => toast('ok', 'Address copied')); };
    $('#tstar').onclick = () => { if (watched(t)) S.watch = S.watch.filter(w => !(w.chain === chain && w.address.toLowerCase() === address.toLowerCase())); else S.watch.push({ chain, address, symbol: t.symbol, name: t.name, icon: t.icon }); store.set('watch', S.watch); head(); };
    document.title = `${t.symbol} ${usd(t.price)} · MINT Trade`;
  };
  const tabs = which => {
    $$('#ttabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.x === which)));
    const el = $('#tx'); if (!info) { el.innerHTML = ''; return; }
    if (which === 'safety') safety(el);
    if (which === 'pools') el.innerHTML = info.pools.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Market</th><th>Pair</th><th class="num">Liquidity</th><th class="num">Volume 24h</th></tr></thead><tbody>${info.pools.map(p => `<tr><td>${esc(p.dex)}</td><td>${esc(info.token.symbol)} / ${esc(p.quote)} <span class="faint mono">${esc(short(p.pool))}</span></td><td class="num">${usd(p.liquidity)}</td><td class="num">${usd(p.volume24h)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No markets found.</div>';
    if (which === 'orders') myOrders(el);
  };
  const safety = async el => {
    const t = info.token, a = info.audit, items = [];
    const sf = (k, v, g) => `<div class="sf ${g}"><small>${k}</small><b>${v}</b></div>`;
    items.push(sf('Liquidity', usd(t.liquidity), (t.liquidity ?? 0) >= 100000 ? 'good' : (t.liquidity ?? 0) >= 20000 ? 'mid' : 'bad'));
    items.push(sf('Age', age(t.createdAt) || 'unknown', Date.now() - Date.parse(t.createdAt || 0) > 7 * 864e5 ? 'good' : 'mid'));
    if (a) {
      items.push(sf('Mint authority', a.mintDisabled ? 'Off' : 'On: more can be minted', a.mintDisabled ? 'good' : 'bad'));
      items.push(sf('Freeze authority', a.freezeDisabled ? 'Off' : 'On: your tokens can be frozen', a.freezeDisabled ? 'good' : 'bad'));
      if (a.topHoldersPct != null) items.push(sf('Top 10 holders', a.topHoldersPct.toFixed(1) + '%', a.topHoldersPct < 30 ? 'good' : a.topHoldersPct < 50 ? 'mid' : 'bad'));
      if (a.devPct != null) items.push(sf('Developer holds', a.devPct.toFixed(2) + '%', a.devPct < 5 ? 'good' : 'mid'));
    }
    if (t.organic) items.push(sf('Organic activity', t.organic, t.organic === 'high' ? 'good' : t.organic === 'medium' ? 'mid' : 'bad'));
    el.innerHTML = `<div class="safety">${items.join('')}</div><div id="srv" class="pad" style="padding-top:0"></div>`;
    if (chain === 'solana' && S.key) try {
      const r = await v1('solana', 'GET', `/v1/tokens/${address}/safety`), bad = (r.issues || r.findings || []).filter(Boolean);
      $('#srv', el).innerHTML = note(r.verdict === 'block' || r.blocked ? 'err' : bad.length ? 'warn' : 'ok', r.verdict === 'block' || r.blocked ? 'The server will refuse to buy this token' : bad.length ? 'The server found risks' : 'The server found no sell traps', esc(bad.map(x => x.message || x.why || x).join(' ')) || 'No freeze, no transfer hooks or fees that could stop a sell.');
    } catch { /* the market data above still stands */ }
  };
  const myOrders = async el => {
    if (!S.key) { el.innerHTML = '<div class="empty">Add your API key in Account to see your orders.</div>'; return; }
    try {
      const os = await v1(chain, 'GET', `/v1/orders?token=${encodeURIComponent(address)}&status=active`), list = Array.isArray(os) ? os : os.orders || [];
      el.innerHTML = list.length ? ordersTable(chain, list) : '<div class="empty">No open orders on this token.</div>'; wireCancel(el, () => myOrders(el));
    } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  };
  $$('#ttabs button').forEach(b => b.onclick = () => tabs(b.dataset.x));
  // chart
  const drawChart = async tf => {
    const box = $('#chart'); if (!box || !info?.token.pool) { if (box) box.innerHTML = '<div class="empty">No chart for this token yet.</div>'; return; }
    try {
      const r = await market('candles', { chain, pool: info.token.pool, tf });
      if (!r.candles.length) { box.innerHTML = '<div class="empty">No trades in this window yet.</div>'; return; }
      if (!window.LightweightCharts) { box.innerHTML = '<div class="empty">The chart library did not load.</div>'; return; }
      const css = getComputedStyle(document.documentElement), col = v => css.getPropertyValue(v).trim();
      if (!S.chart) {
        box.innerHTML = '';
        S.chart = LightweightCharts.createChart(box, { autoSize: true, layout: { background: { color: 'transparent' }, textColor: col('--muted'), fontFamily: 'Geist, sans-serif' }, grid: { vertLines: { color: col('--line') }, horzLines: { color: col('--line') } }, rightPriceScale: { borderColor: col('--line') }, timeScale: { borderColor: col('--line'), timeVisible: true }, crosshair: { mode: 0 } });
        S.series = S.chart.addCandlestickSeries({ upColor: col('--up'), downColor: col('--down'), borderVisible: false, wickUpColor: col('--up'), wickDownColor: col('--down'), priceFormat: { type: 'custom', formatter: p => usd(p, { compact: false }), minMove: 1e-12 } });
        S.vol = S.chart.addHistogramSeries({ priceScaleId: '', priceFormat: { type: 'volume' } }); S.vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      }
      S.series.setData(r.candles.map(c => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c })));
      S.vol.setData(r.candles.map(c => ({ time: c.t, value: c.v, color: c.c >= c.o ? col('--up-soft') : col('--down-soft') })));
      $('#chartsrc').textContent = r.stale ? 'Candles from a minute ago' : 'Candles by GeckoTerminal';
    } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  };
  $$('#tfs button').forEach(b => b.onclick = () => { store.set('tf', b.dataset.tf); $$('#tfs button').forEach(x => x.setAttribute('aria-selected', String(x === b))); if (S.chart) { S.chart.remove(); S.chart = null; } drawChart(b.dataset.tf); });
  // trade panel
  const panel = { side: 'buy', type: 'market', slip: store.get('slip', 3) };
  const loadPos = async () => {
    if (!S.key || !S.wallets[chain]?.linked) { pos = null; return; }
    try { const ps = await v1(chain, 'GET', '/v1/positions'); pos = (Array.isArray(ps) ? ps : ps.positions || []).find(p => String(p.token).toLowerCase() === address.toLowerCase()) || null; } catch { pos = null; }
  };
  const trade = () => {
    const el = $('#trade'), t = info?.token, sym = t?.symbol ?? '…', why = needSetup(chain), bal = pos && decimals != null ? fromRaw(pos.balance, decimals) : null;
    el.innerHTML = `<div class="bs" role="tablist"><button data-side="buy" aria-selected="${panel.side === 'buy'}">Buy</button><button data-side="sell" aria-selected="${panel.side === 'sell'}">Sell</button></div>
      <div class="tabs" role="tablist">${[['market', 'Market'], ['limit', 'Limit'], ['tpsl', panel.side === 'buy' ? 'Dip buy' : 'TP / SL'], ['twap', 'TWAP']].filter(([k]) => !(panel.side === 'buy' && k === 'tpsl')).map(([k, l]) => `<button data-type="${k}" aria-selected="${panel.type === k}">${l}</button>`).join('')}</div>
      <div class="body" id="tbody"></div>
      <div class="pos"><div class="row"><span class="muted">Your position</span><b>${bal != null ? amt(bal) + ' ' + esc(sym) : '—'}</b></div>
        <div class="row"><span class="muted">Value</span><b>${bal != null && t?.price ? usd(bal * t.price) : '—'}</b></div>
        <div class="row"><span class="muted">Cost</span><b>${pos?.knownCost && S.natives[chain] ? usd(fromRaw(pos.knownCost, C.dec) * S.natives[chain]) : '—'}</b></div>
        <div class="row"><span class="muted">Profit / loss</span><b class="${pos && bal != null && t?.price && S.natives[chain] ? cls(bal * t.price - fromRaw(pos.knownCost, C.dec) * S.natives[chain]) : ''}">${pos && bal != null && t?.price && S.natives[chain] && pos.knownCost ? usd(bal * t.price - fromRaw(pos.knownCost, C.dec) * S.natives[chain]) : '—'}</b></div></div>`;
    $$('.bs button', el).forEach(b => b.onclick = () => { panel.side = b.dataset.side; if (panel.side === 'buy' && panel.type === 'tpsl') panel.type = 'market'; trade(); });
    $$('.tabs button', el).forEach(b => b.onclick = () => { panel.type = b.dataset.type; trade(); });
    const body = $('#tbody', el);
    if (why) { body.innerHTML = note('warn', 'Not ready to trade', esc(why)) + `<a class="btn block" href="#/setup">Open Account</a>`; return; }
    const isBuy = panel.side === 'buy', unit = isBuy ? C.native : sym;
    const amountField = isBuy ? `<label class="field"><span>Amount</span><span class="input"><input class="big" id="tamt" inputmode="decimal" placeholder="0.0" value="${esc(S.quick[chain])}"><span class="unit">${C.native}</span></span></label><div class="chips">${C.presets.map(p => `<button class="chip" data-p="${p}">${p}</button>`).join('')}</div>`
      : `<label class="field"><span>Amount</span><span class="input"><input class="big" id="tamt" inputmode="decimal" placeholder="0.0"><span class="unit">${esc(sym)}</span></span></label><div class="chips">${[25, 50, 75, 100].map(p => `<button class="chip" data-pct="${p}">${p}%</button>`).join('')}</div>`;
    const priceField = l => `<label class="field"><span>${l}</span><span class="input"><span class="unit">$</span><input id="tpx" inputmode="decimal" placeholder="${t?.price ? usd(t.price, { compact: false }).replace('$', '') : ''}"></span></label>`;
    const slip = `<details class="adv"><summary>Slippage ${panel.slip}%${chain === 'solana' ? ' · MEV protection' : ''}</summary><div class="chips">${[1, 3, 5, 10, 20].map(s => `<button class="chip" data-slip="${s}" aria-pressed="${panel.slip === s}">${s}%</button>`).join('')}</div>${chain === 'solana' ? '<label class="check"><input type="checkbox" id="tmev"> Send privately through Jito (small tip)</label>' : ''}</details>`;
    if (panel.type === 'market') body.innerHTML = amountField + `<div class="sum" id="tsum"></div>` + slip + `<div id="tout"></div><button class="btn ${isBuy ? 'primary' : 'sell'} block" id="tgo">${isBuy ? 'Buy' : 'Sell'} ${esc(sym)}</button>`;
    if (panel.type === 'limit') body.innerHTML = amountField + priceField(isBuy ? 'Buy when the price falls to' : 'Sell when the price rises to') + slip + `<div id="tout"></div><button class="btn ${isBuy ? 'primary' : 'sell'} block" id="tgo">Place limit ${isBuy ? 'buy' : 'sell'}</button>`;
    if (panel.type === 'tpsl') body.innerHTML = `<label class="field"><span>Share of your position</span><span class="input"><input class="big" id="tamt" inputmode="decimal" value="100"><span class="unit">%</span></span></label><label class="field"><span>Take profit at</span><span class="input"><span class="unit">$</span><input id="ttp" inputmode="decimal" placeholder="${t?.price ? (t.price * 2).toPrecision(4) : ''}"></span></label><label class="field"><span>Stop loss at</span><span class="input"><span class="unit">$</span><input id="tsl" inputmode="decimal" placeholder="${t?.price ? (t.price * 0.7).toPrecision(4) : ''}"></span></label><p class="faint" style="margin:0;font-size:12.5px">When one fires, the other is cancelled.</p><div id="tout"></div><button class="btn sell block" id="tgo">Set take profit / stop loss</button>`;
    if (panel.type === 'twap') body.innerHTML = amountField + `<div class="pair"><label class="field"><span>Slices</span><span class="input"><input id="tsl" inputmode="numeric" value="5"></span></label><label class="field"><span>Every</span><span class="input"><input id="tiv" inputmode="numeric" value="60"><span class="unit">sec</span></span></label></div><p class="faint" style="margin:0;font-size:12.5px">Each slice is a real ${isBuy ? 'buy' : 'sell'} at the market price.</p><div id="tout"></div><button class="btn ${isBuy ? 'primary' : 'sell'} block" id="tgo">Start TWAP</button>`;
    $$('[data-p]', body).forEach(b => b.onclick = () => { $('#tamt').value = b.dataset.p; quote(); });
    $$('[data-pct]', body).forEach(b => b.onclick = () => { if (bal != null) { $('#tamt').value = String(+(bal * +b.dataset.pct / 100).toPrecision(8)); $('#tamt').dataset.pct = b.dataset.pct; quote(); } else toast('warn', 'No position', 'You hold none of this token on ' + C.label + '.'); });
    $$('[data-slip]', body).forEach(b => b.onclick = () => { panel.slip = +b.dataset.slip; store.set('slip', panel.slip); trade(); });
    const amtIn = $('#tamt'); if (amtIn) amtIn.oninput = () => { delete amtIn.dataset.pct; clearTimeout(S.qt); S.qt = setTimeout(quote, 350); };
    const go = $('#tgo'), out = $('#tout');
    const quote = async () => {
      const sum = $('#tsum'); if (!sum || panel.type !== 'market') return; const v = $('#tamt').value.trim();
      const raw = isBuy ? toRaw(v, C.dec) : decimals != null ? toRaw(v, decimals) : null;
      if (!raw || raw === '0') { sum.innerHTML = ''; return; }
      sum.innerHTML = `<div><span>You get about</span><b>…</b></div>`;
      try {
        const q = await v1(chain, 'POST', '/v1/quote', { side: panel.side, token: address, amount: raw, slippageBps: panel.slip * 100 });
        const outDec = isBuy ? decimals : C.dec, outSym = isBuy ? sym : C.native, o = fromRaw(q.amountOut, outDec), mn = fromRaw(q.minOut, outDec);
        const outUsd = isBuy ? (o != null && t?.price ? o * t.price : null) : (o != null && S.natives[chain] ? o * S.natives[chain] : null);
        sum.innerHTML = `<div><span>You get about</span><b>${o != null ? amt(o, 6) + ' ' + esc(outSym) : esc(q.amountOut)}${outUsd ? ` <span class="faint">${usd(outUsd)}</span>` : ''}</b></div><div><span>Minimum after ${panel.slip}%</span><b>${mn != null ? amt(mn, 6) : '—'}</b></div><div><span>Price impact</span><b class="${(q.priceImpactBps ?? 0) > 300 ? 'down' : ''}">${q.priceImpactBps != null ? (q.priceImpactBps / 100).toFixed(2) + '%' : '—'}</b></div><div><span>Route</span><b>${esc(String(q.venue || '').split(':')[0])}</b></div>`;
      } catch (e) { sum.innerHTML = note('warn', 'No quote', esc(e.message)); }
    };
    quote();
    go.onclick = async () => {
      go.disabled = true; out.innerHTML = '';
      const v = $('#tamt')?.value.trim(), px = $('#tpx')?.value.trim(), mev = $('#tmev')?.checked || undefined, sell = (b) => { const p = $('#tamt')?.dataset.pct; if (p) b.pct = +p; else b.tokens = v; return b; };
      try {
        if (panel.type === 'market') {
          if (isBuy && !(await ensureFunds(chain, v, out))) { go.disabled = false; return; }
          out.innerHTML = note('', 'Sending', 'The server builds the trade, Privy signs it, the server sends it.');
          const b = isBuy ? { token: address, [C.key]: v, slippagePct: panel.slip, mevProtection: mev } : sell({ token: address, slippagePct: panel.slip, mevProtection: mev });
          const tr = await runTrade(chain, isBuy ? '/v1/trades/buy' : '/v1/trades/sell', b, s => { out.innerHTML = note('', 'Sending', 'State: ' + esc(s)); });
          const sent = (tr.history || []).some(x => x.state === 'submitted');
          out.innerHTML = tr.state === 'finalized' ? note('ok', isBuy ? 'Bought' : 'Sold', `<a href="${esc(explorer(chain, tr.txHash))}" target="_blank" rel="noopener noreferrer">View transaction</a>`) : note('err', 'Trade ' + esc(tr.state), (sent ? 'It was sent. ' : 'Nothing was sent. ') + esc(tr.failure || ''));
          if (tr.state === 'finalized') { toast('ok', `${isBuy ? 'Bought' : 'Sold'} ${sym}`, C.label); await loadPos(); setTimeout(trade, 2500); }
        } else if (panel.type === 'limit') {
          if (!px) throw new Error('Set the trigger price.');
          const r = await v1(chain, 'POST', isBuy ? '/v1/orders/limit-buy' : '/v1/orders/limit-sell', isBuy ? { token: address, [C.key]: v, priceUsd: px, slippagePct: panel.slip } : sell({ token: address, priceUsd: px, slippagePct: panel.slip }));
          out.innerHTML = note('ok', 'Order placed', `It trades by itself when the price reaches $${esc(px)}. Id ${esc(r.id || '')}.`); toast('ok', 'Limit order placed', sym);
        } else if (panel.type === 'tpsl') {
          const tp = $('#ttp').value.trim(), sl = $('#tsl').value.trim(); if (!tp && !sl) throw new Error('Set a take-profit price, a stop-loss price, or both.');
          const r = await v1(chain, 'POST', '/v1/orders/bracket', { token: address, pct: +v || 100, ...(tp ? { tpUsd: tp } : {}), ...(sl ? { slUsd: sl } : {}) });
          out.innerHTML = note('ok', 'Protection set', `${tp ? 'Take profit at $' + esc(tp) + '. ' : ''}${sl ? 'Stop loss at $' + esc(sl) + '.' : ''} Id ${esc(r.id || '')}.`); toast('ok', 'Take profit / stop loss set', sym);
        } else if (panel.type === 'twap') {
          const slices = +$('#tsl').value, iv = +$('#tiv').value;
          const r = await v1(chain, 'POST', '/v1/twap', { token: address, side: panel.side, slices, intervalS: iv, ...(isBuy ? { [C.key]: v } : { tokens: v }), slippageBps: panel.slip * 100 });
          out.innerHTML = note('ok', 'TWAP started', `${slices} slices, one every ${iv} s. Id ${esc(r.id || '')}.`); toast('ok', 'TWAP started', sym);
        }
      } catch (e) { out.innerHTML = note('err', 'Not done', esc(e.message)); }
      go.disabled = false;
    };
  };
  // load everything
  (async () => {
    try { info = await market('token', { chain, address }); }
    catch (e) { $('#thead').innerHTML = note('err', 'Token not found', esc(e.message)); trade(); return; }
    head(); tabs('safety'); drawChart(store.get('tf', '15m'));
    const get = await loadMeta(chain, [address]); decimals = get(address).decimals ?? null;
    await loadPos(); trade();
  })();
  every(20000, async () => { try { info = await market('token', { chain, address }); head(); } catch { /* keep last */ } });
  every(30000, () => drawChart(store.get('tf', '15m')));
};

/* orders table, shared */
function ordersTable(chain, list) {
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Order</th><th>Token</th><th class="num">Trigger</th><th>Status</th><th class="num"></th></tr></thead><tbody>${list.map(o => {
    const m = meta[chain + ':' + String(o.token).toLowerCase()] || {}, trig = o.priceUsd ?? o.triggerUsd ?? null;
    return `<tr><td>${badge(chain)} ${esc(String(o.type || o.kind || 'order').replace(/-/g, ' '))}</td><td>${esc(m.symbol || short(o.token))}</td><td class="num">${trig ? usd(+trig, { compact: false }) : o.trailBps ? (o.trailBps / 100) + '% trail' : '—'}</td><td class="muted">${esc(o.status || '')}${o.why ? ' · ' + esc(o.why) : ''}</td><td class="num">${o.status === 'active' ? `<button class="btn sm" data-cancel="${esc(chain)}|${esc(o.id)}">Cancel</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>`;
}
function wireCancel(el, after) {
  $$('[data-cancel]', el).forEach(b => b.onclick = async () => { const [c, id] = b.dataset.cancel.split('|'); b.disabled = true;
    try { await v1(c, 'DELETE', `/v1/orders/${encodeURIComponent(id)}`); toast('ok', 'Order cancelled', 'Its reserved balance is free again.'); after(); } catch (e) { toast('err', 'Not cancelled', e.message); b.disabled = false; } });
}

/* Portfolio */
V.portfolio = async (main) => {
  const tab = store.get('ptab', 'positions');
  main.innerHTML = `<div class="page"><div class="ph"><div><h1>Portfolio</h1><p>Everything you hold and have open, on every linked chain.</p></div></div>
    <div class="kpis" id="kpis">${['Total', ...IDS.map(c => CH[c].label)].map((l, i) => `<div class="card kpi${i ? '' : ' total'}"><small>${i ? badge(IDS[i - 1]) : ''}${esc(l)}</small><b><span class="skel" style="width:90px;height:20px"></span></b></div>`).join('')}</div>
    <div class="card"><div class="tabs" id="ptabs">${[['positions', 'Positions'], ['orders', 'Open orders'], ['history', 'History']].map(([k, l]) => `<button data-p="${k}" aria-selected="${tab === k}">${l}</button>`).join('')}</div><div id="pbody"><div class="pad"><span class="skel" style="width:60%"></span></div></div></div></div>`;
  $$('#ptabs button').forEach(b => b.onclick = () => { store.set('ptab', b.dataset.p); route(); });
  if (!S.key) { $('#pbody').innerHTML = `<div class="empty"><b>Add your API key to see your portfolio</b><a class="btn sm" href="#/setup">Open Account</a></div>`; $('#kpis').innerHTML = ''; return; }
  const chains = S.served.filter(c => S.wallets[c]?.linked);
  if (!chains.length) { $('#pbody').innerHTML = `<div class="empty"><b>No wallet linked yet</b>Link your wallet on each chain in Account. <a class="btn sm" href="#/setup">Open Account</a></div>`; }
  // native balances
  const bal = {};
  const evmAddr = IDS.map(c => S.wallets[c]?.address).find(a => a && a.startsWith('0x'));
  await Promise.all([
    evmAddr ? page('/api/sol/evm/balances', { address: evmAddr }).then(r => r.chains.forEach(c => { if (c.ok) bal[c.chain] = Number(c.wei) / 1e18; })).catch(() => {}) : null,
    S.wallets.solana?.address ? fetch('/api/sol/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [S.wallets.solana.address] }) }).then(r => r.json()).then(j => { if (j?.result?.value != null) bal.solana = j.result.value / 1e9; }).catch(() => {}) : null,
  ]);
  // positions
  const all = [];
  await Promise.all(chains.map(async c => { try { const ps = await v1(c, 'GET', '/v1/positions'); const list = (Array.isArray(ps) ? ps : ps.positions || []).filter(p => p.balance && p.balance !== '0'); const get = await loadMeta(c, list.map(p => p.token)); list.forEach(p => all.push({ chain: c, p, m: get(p.token) })); } catch { /* chain shown as unavailable */ } }));
  const nat = c => (bal[c] ?? 0) * (S.natives[c] ?? 0), posVal = r => { const q = fromRaw(r.p.balance, r.m.decimals); return q != null && r.m.price ? q * r.m.price : 0; };
  const byChain = c => nat(c) + all.filter(r => r.chain === c).reduce((s, r) => s + posVal(r), 0), total = IDS.reduce((s, c) => s + byChain(c), 0);
  $('#kpis').innerHTML = `<div class="card kpi total"><small>Total</small><b>${usd(total, { compact: false })}</b></div>` + IDS.map(c => `<div class="card kpi"><small>${badge(c)}${esc(CH[c].label)}</small><b>${usd(byChain(c), { compact: false })}</b><span class="faint" style="font-size:12px">${bal[c] != null ? amt(bal[c], 5) + ' ' + CH[c].native : S.wallets[c]?.linked ? '' : 'Not linked'}</span></div>`).join('');
  const el = $('#pbody'); if (!chains.length) return;
  if (tab === 'positions') {
    el.innerHTML = all.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Token</th><th class="num">Amount</th><th class="num hide-s">Price</th><th class="num">Value</th><th class="num hide-s">Cost</th><th class="num">Profit / loss</th><th class="num"></th></tr></thead><tbody>${all.map((r, i) => {
      const q = fromRaw(r.p.balance, r.m.decimals), v = posVal(r), cost = r.p.knownCost && S.natives[r.chain] ? fromRaw(r.p.knownCost, CH[r.chain].dec) * S.natives[r.chain] : null, pl = cost != null && v ? v - cost : null;
      return `<tr data-i="${i}"><td><div class="tok">${icon({ ...r.m, chain: r.chain, symbol: r.m.symbol || '?' })}<div><b>${esc(r.m.symbol || short(r.p.token))}</b><small>${esc(CH[r.chain].label)}</small></div></div></td><td class="num">${q != null ? amt(q) : '—'}</td><td class="num hide-s">${usd(r.m.price)}</td><td class="num">${v ? usd(v) : '—'}</td><td class="num hide-s">${cost != null ? usd(cost) : '<span class="faint">unknown</span>'}</td><td class="num ${cls(pl)}">${pl != null ? usd(pl) + ` <small>${pct(pl / cost * 100)}</small>` : '—'}</td><td class="num"><button class="btn sm" data-sell="50">Sell 50%</button> <button class="btn sm" data-sell="100">Sell all</button></td></tr>`; }).join('')}</tbody></table></div>`
      : `<div class="empty"><b>No positions yet</b>Buy something from <a href="#/">Discover</a>.</div>`;
    $$('tr[data-i]', el).forEach(tr => { const r = all[+tr.dataset.i];
      tr.onclick = e => { if (!e.target.closest('button')) location.hash = `#/t/${r.chain}/${r.p.token}`; };
      $$('[data-sell]', tr).forEach(b => b.onclick = () => sellPct(r, +b.dataset.sell)); });
  }
  if (tab === 'orders') {
    const rows = []; await Promise.all(chains.map(async c => { try { const os = await v1(c, 'GET', '/v1/orders?status=active'); const list = Array.isArray(os) ? os : os.orders || []; await loadMeta(c, list.map(o => o.token)); list.forEach(o => rows.push([c, o])); } catch { /* skip */ } }));
    el.innerHTML = rows.length ? rows.map(([c, o]) => ordersTable(c, [o])).join('') : '<div class="empty"><b>No open orders</b>Limit, take-profit and stop-loss orders you place show up here.</div>';
    wireCancel(el, () => route());
  }
  if (tab === 'history') {
    // the server's trade records carry no time: it comes from the chain (the transaction's block), else from a key this app or the old page made (ui-/app-<ms>)
    const rows = []; await Promise.all(chains.map(async c => { try {
      const ts = await v1(c, 'GET', '/v1/trades?limit=40'), list = (Array.isArray(ts) ? ts : ts.trades || []).map(t => { const buy = t.tokenIn === 'NATIVE' || t.side === 'buy'; return { ...t, side: t.side || (buy ? 'buy' : 'sell'), token: t.token || (buy ? t.tokenOut : t.tokenIn) }; });
      const [, times] = await Promise.all([loadMeta(c, list.map(t => t.token).filter(t => t && t !== 'NATIVE')), market('txtimes', { chain: c, hashes: list.map(t => t.txHash).filter(Boolean) }).then(r => r.times).catch(() => ({}))]);
      list.forEach(t => { const k = /(?:^|[.-])(?:ui|app)-(\d{13})/.exec(String(t.key || ''))?.[1]; t.when = times[t.txHash] ? times[t.txHash] * 1000 : k ? +k : null; rows.push([c, t]); });
    } catch { /* that chain is skipped */ } }));
    rows.sort((a, b) => (b[1].when ?? 0) - (a[1].when ?? 0));
    const ago = ms => { const s = (Date.now() - ms) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : null; };
    const amount = (c, t) => { if (t.amountIn == null) return ''; const buy = t.side === 'buy', m = meta[c + ':' + String(t.token).toLowerCase()] || {}, v = fromRaw(t.amountIn, buy ? CH[c].dec : m.decimals); return v == null ? '' : `${amt(v, 6)} ${buy ? CH[c].native : esc(m.symbol || '')}`; };
    el.innerHTML = rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Trade</th><th>Token</th><th class="num hide-s">Spent</th><th>State</th><th class="num"></th></tr></thead><tbody>${rows.map(([c, t]) => { const m = meta[c + ':' + String(t.token).toLowerCase()] || {};
      return `<tr><td class="muted" style="white-space:nowrap">${t.when ? `${new Date(t.when).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${ago(t.when) ? `<br><small class="faint">${ago(t.when)}</small>` : ''}` : '<span class="faint">unknown</span>'}</td><td>${badge(c)} <span class="${t.side === 'buy' ? 'up' : 'down'}" style="font-weight:600">${t.side === 'buy' ? 'Buy' : 'Sell'}</span>${t.origin && t.origin !== 'manual' ? ` <span class="faint">${esc(t.origin)}</span>` : ''}</td><td>${esc(m.symbol || short(t.token))}</td><td class="num hide-s">${amount(c, t)}</td><td class="${t.state === 'failed' ? 'down' : t.state === 'finalized' ? 'up' : 'muted'}">${esc(t.state === 'finalized' ? 'Done' : t.state)}${t.failure ? ` <span class="faint">${esc(t.failure).slice(0, 80)}</span>` : ''}</td><td class="num">${t.txHash ? `<a class="btn sm ghost" href="${esc(explorer(c, t.txHash))}" target="_blank" rel="noopener noreferrer">View</a>` : ''}</td></tr>`; }).join('')}</tbody></table></div>` : '<div class="empty"><b>No trades yet</b></div>';
  }
};
function sellPct(r, p) {
  const sym = r.m.symbol || short(r.p.token), C = CH[r.chain];
  dialog(`Sell ${p}% of ${sym}`, `<div class="sum"><div><span>Chain</span><b>${badge(r.chain)} ${esc(C.label)}</b></div><div><span>Sell</span><b>${p}% of your ${esc(sym)}</b></div></div><div id="dout"></div><button class="btn sell block" id="dgo">Sell ${p}%</button>`, d => {
    $('#dgo', d).onclick = async () => { const b = $('#dgo', d), out = $('#dout', d); b.disabled = true;
      try { const t = await runTrade(r.chain, '/v1/trades/sell', { token: r.p.token, pct: p, slippagePct: 5 }, s => { out.innerHTML = note('', 'Selling', 'State: ' + esc(s)); });
        out.innerHTML = t.state === 'finalized' ? note('ok', 'Sold', `<a href="${esc(explorer(r.chain, t.txHash))}" target="_blank" rel="noopener noreferrer">View transaction</a>`) : note('err', 'Trade ' + esc(t.state), esc(t.failure || ''));
        if (t.state === 'finalized') { toast('ok', 'Sold ' + sym); setTimeout(() => { d.close(); route(); }, 1200); } else b.disabled = false;
      } catch (e) { out.innerHTML = note('err', 'Not done', esc(e.message)); b.disabled = false; } };
  });
}

/* Copy trading (Solana) */
V.copy = async (main) => {
  main.innerHTML = `<div class="page"><div class="ph"><div><h1>Copy trading</h1><p>Follow up to 10 wallets on Solana. When they buy, you buy with your own size and limits; when they sell, you can follow them out.</p></div></div>
    <div class="grid2"><div class="card"><h2>Running copies</h2><div id="clist" class="pad"><span class="skel" style="width:50%"></span></div></div>
    <form class="card form" id="cform" autocomplete="off"><h2 style="padding:0;font-size:15px">Copy a wallet</h2>
      <label class="field"><span>Leader wallets (one per line)</span><textarea id="cl" rows="3" class="input" style="padding:10px 12px;resize:vertical;font-family:var(--mono);font-size:12.5px" placeholder="Solana address" spellcheck="false"></textarea></label>
      <div class="seg" id="csz"><button type="button" data-z="fixed" aria-selected="true">Fixed size</button><button type="button" data-z="percent" aria-selected="false">Share of theirs</button></div>
      <label class="field"><span id="cszl">SOL per copied buy</span><span class="input"><input id="cv" inputmode="decimal" value="0.05"><span class="unit" id="cvu">SOL</span></span></label>
      <div class="pair"><label class="field"><span>Max per trade</span><span class="input"><input id="cmax" inputmode="decimal" value="0.2"><span class="unit">SOL</span></span></label><label class="field"><span>Max per day</span><span class="input"><input id="cday" inputmode="decimal" value="1"><span class="unit">SOL</span></span></label></div>
      <label class="field"><span>When they sell</span><span class="input"><select id="cexit"><option value="proportional">Sell the same share they sold</option><option value="full-on-exit">Sell everything when they fully exit</option><option value="full-on-any-sell">Sell everything on any sell</option><option value="ignore">Keep my position</option></select></span></label>
      <label class="check"><input type="checkbox" id="ctest" checked> Test first: record what would be bought, send nothing</label>
      <div id="cout"></div><button class="btn primary block" type="submit">Start copying</button></form></div></div>`;
  let mode = 'fixed';
  $$('#csz button').forEach(b => b.onclick = () => { mode = b.dataset.z; $$('#csz button').forEach(x => x.setAttribute('aria-selected', String(x === b))); $('#cszl').textContent = mode === 'fixed' ? 'SOL per copied buy' : 'Share of what they spend'; $('#cvu').textContent = mode === 'fixed' ? 'SOL' : '%'; $('#cv').value = mode === 'fixed' ? '0.05' : '10'; });
  const list = async () => {
    const el = $('#clist'); if (!S.key) { el.innerHTML = `<div class="empty"><b>Add your API key first</b><a class="btn sm" href="#/setup">Open Account</a></div>`; return; }
    try {
      const cs = await v1('solana', 'GET', '/v1/copies'), arr = Array.isArray(cs) ? cs : cs.copies || [];
      el.innerHTML = arr.length ? arr.map(c => `<div class="step" style="grid-template-columns:1fr auto"><div><b>${esc((c.leaders || []).map(short).join(', '))}</b><small>${c.sizing?.fixedLamports ? fromRaw(c.sizing.fixedLamports, 9) + ' SOL each' : (c.sizing?.percent ?? '?') + '% of theirs'} · ${esc(c.exitMode || '')}${c.trackOnly ? ' · test mode' : ''}${c.lastError ? ` · <span class="down">${esc(c.lastError)}</span>` : ''}</small></div><button class="btn sm" data-stop="${esc(c.id)}">Stop</button></div>`).join('') : '<div class="empty"><b>Not copying anyone yet</b>Paste a wallet on the right.</div>';
      $$('[data-stop]', el).forEach(b => b.onclick = async () => { b.disabled = true; try { await v1('solana', 'DELETE', `/v1/copies/${encodeURIComponent(b.dataset.stop)}`); toast('ok', 'Copy stopped', 'Copies already sent finish on the chain.'); list(); } catch (e) { toast('err', 'Not stopped', e.message); b.disabled = false; } });
    } catch (e) { el.innerHTML = note('err', 'Copy trading is unavailable', esc(e.message)); }
  };
  $('#cform').onsubmit = async e => {
    e.preventDefault(); const out = $('#cout'), leaders = $('#cl').value.split(/\s+/).map(s => s.trim()).filter(Boolean);
    if (!leaders.length) { out.innerHTML = note('warn', 'Add a wallet to copy'); return; }
    const why = needSetup('solana'); if (why && !$('#ctest').checked) { out.innerHTML = note('warn', 'Not ready to trade', esc(why)); return; }
    const body = { leaders, ...(mode === 'fixed' ? { fixedSol: $('#cv').value.trim() } : { percent: +$('#cv').value }), maxPerTradeSol: $('#cmax').value.trim(), dailySol: $('#cday').value.trim(), exitMode: $('#cexit').value, trackOnly: $('#ctest').checked };
    try { await v1('solana', 'POST', '/v1/copies', body); out.innerHTML = note('ok', body.trackOnly ? 'Copying in test mode' : 'Copying', body.trackOnly ? 'Nothing will be bought. Turn test mode off when you are happy with what it records.' : 'Their next buy will be copied with your size and limits.'); list(); }
    catch (err) { out.innerHTML = note('err', 'Not started', esc(err.message)); }
  };
  list();
};

/* RFQ: the desk's quote comparison (market maker vs routes), read-only. Trading happens on the token page: on Solana the server itself takes the maker's fill when it wins. */
V.rfq = async (main) => {
  const st = store.get('rfq', { chain: 'solana', side: 'buy', pay: 'USDC', amount: '1000', symbol: '' });
  if (S.chain !== 'all' && st.chain !== S.chain && !st.pinned) st.chain = S.chain;
  main.innerHTML = `<div class="page"><div class="ph"><div><h1>RFQ quotes</h1><p>Compare a market maker's firm price with the routers for a stock, at any size. Solana uses JupiterZ makers; Base, Robinhood and BNB compare every venue. Nothing is signed here.</p></div></div>
    <div class="grid2"><div style="display:grid;gap:16px;min-width:0" id="rres"><div class="card"><div class="empty"><b>Pick a stock and a size</b>The comparison shows here.</div></div></div>
    <form class="card form" id="rform" autocomplete="off"><h2 style="padding:0;font-size:15px">Request a quote</h2>
      <div class="seg" id="rchain">${IDS.map(c => `<button type="button" data-c="${c}" aria-selected="${st.chain === c}">${badge(c)} ${esc(CH[c].short)}</button>`).join('')}</div>
      <label class="field"><span>Stock</span><span class="input"><select id="rsym"><option>Loading…</option></select></span></label>
      <div class="bs" style="margin:0" id="rside"><button type="button" data-side="buy" aria-selected="${st.side === 'buy'}">Buy</button><button type="button" data-side="sell" aria-selected="${st.side === 'sell'}">Sell</button></div>
      <div id="rpayw"></div>
      <label class="field"><span id="ramtl">Amount</span><span class="input"><input class="big" id="ramt" inputmode="decimal" value="${esc(st.amount)}"><span class="unit" id="ramtu"></span></span></label>
      <div class="chips" id="rpre"></div>
      <div id="rout"></div><button class="btn primary block">Compare quotes</button></form></div></div>`;
  let cfg; try { cfg = await page('/api/sol/rfq/config', {}); } catch (e) { $('#rres').innerHTML = `<div class="card pad">${note('err', 'The RFQ desk is unavailable', esc(e.message))}</div>`; return; }
  const save = () => store.set('rfq', st);
  const unit = () => st.chain === 'solana' ? (st.side === 'buy' ? st.pay : 'shares') : (st.side === 'buy' ? CH[st.chain].native : 'tokens');
  const presets = () => st.chain === 'solana' ? (st.side === 'buy' ? (st.pay === 'USDC' ? ['1000', '10000', '50000', '100000'] : ['10', '100', '500', '1000']) : ['1', '10', '50', '100']) : (st.side === 'buy' ? CH[st.chain].presets.concat(['0.05', '0.1']).slice(1) : ['0.01', '0.1', '1', '10']);
  const draw = () => {
    $$('#rchain button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.c === st.chain)));
    $$('#rside button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.side === st.side)));
    const syms = st.chain === 'solana' ? cfg.stocks.map(s => [s.mint, `${s.symbol} · ${s.issuer}`, s.symbol]) : (cfg.evm[st.chain]?.symbols || []).map(s => [s, s, s]);
    $('#rsym').innerHTML = syms.length ? syms.map(([v, l, s]) => `<option value="${esc(v)}" ${v === st.symbol || s === st.symbol ? 'selected' : ''}>${esc(l)}</option>`).join('') : '<option value="">No stocks on this chain</option>';
    if (!syms.some(([v, , s]) => v === st.symbol || s === st.symbol)) st.symbol = syms[0]?.[0] ?? '';
    $('#rpayw').innerHTML = st.chain === 'solana' && st.side === 'buy' ? `<div class="seg" id="rpay">${['USDC', 'SOL'].map(p => `<button type="button" data-p="${p}" aria-selected="${st.pay === p}">Pay with ${p}</button>`).join('')}</div>` : '';
    $$('#rpay button').forEach(b => b.onclick = () => { st.pay = b.dataset.p; st.amount = st.pay === 'USDC' ? '1000' : '10'; $('#ramt').value = st.amount; save(); draw(); });
    $('#ramtu').textContent = unit(); $('#ramtl').textContent = st.side === 'buy' ? 'You pay' : 'You sell';
    $('#rpre').innerHTML = presets().map(p => `<button type="button" class="chip" data-a="${p}">${st.chain === 'solana' && st.side === 'buy' && st.pay === 'USDC' ? '$' + Number(p).toLocaleString('en-US') : p}</button>`).join('');
    $$('#rpre [data-a]').forEach(b => b.onclick = () => { st.amount = b.dataset.a; $('#ramt').value = st.amount; save(); });
  };
  $$('#rchain button').forEach(b => b.onclick = () => { st.chain = b.dataset.c; st.pinned = true; st.symbol = ''; st.amount = presets()[0]; $('#ramt').value = st.amount; save(); draw(); $('#ramt').value = st.amount = presets()[0]; });
  $$('#rside button').forEach(b => b.onclick = () => { st.side = b.dataset.side; save(); draw(); st.amount = presets()[0]; $('#ramt').value = st.amount; save(); });
  $('#rsym').onchange = e => { st.symbol = e.target.value; save(); };
  $('#ramt').oninput = e => { st.amount = e.target.value.trim(); save(); };
  draw();
  $('#rform').onsubmit = async e => {
    e.preventDefault(); const out = $('#rout'), res = $('#rres'), btn = $('button.primary', $('#rform')); out.innerHTML = '';
    if (!(Number(st.amount) > 0)) { out.innerHTML = note('warn', 'Set an amount'); return; }
    btn.disabled = true; res.innerHTML = `<div class="card pad"><div class="note"><div><b>Asking the market makers and routers…</b> This takes 5 to 40 seconds.</div></div><div style="display:grid;gap:8px;margin-top:12px"><span class="skel" style="width:70%"></span><span class="skel" style="width:55%"></span><span class="skel" style="width:62%"></span></div></div>`;
    try { res.innerHTML = st.chain === 'solana' ? await rfqSolana(cfg, st) : await rfqEvm(st); }
    catch (err) { res.innerHTML = `<div class="card pad">${note('err', 'No comparison', esc(err.message))}</div>`; }
    btn.disabled = false;
  };
};
async function rfqSolana(cfg, st) {
  const stock = cfg.stocks.find(s => s.mint === st.symbol); if (!stock) throw new Error('Pick a stock.');
  const payDec = st.pay === 'USDC' ? 6 : 9, inDec = st.side === 'buy' ? payDec : stock.decimals, outDec = st.side === 'buy' ? stock.decimals : (st.pay === 'USDC' ? 6 : 9);
  const raw = toRaw(st.amount, inDec); if (!raw) throw new Error('Set an amount like 1000.');
  const { stages } = await page('/api/sol/rfq/quote', { mint: stock.mint, side: st.side, pay: st.side === 'buy' ? st.pay : 'USDC', amount: raw });
  const g = k => stages.filter(s => s.stage === k).pop() || null, err = g('error');
  if (err) throw new Error(err.error || 'The desk could not quote this.');
  const ctx = g('context') || {}, sk = g('stock') || {}, rfq = g('rfq'), other = g('other'), build = g('build'), dec = g('decision'), cap = g('capacity'), ven = g('venues')?.venues || [];
  const outSym = st.side === 'buy' ? stock.symbol : (st.pay === 'USDC' ? 'USDC' : 'SOL'), q = r => r == null ? null : fromRaw(String(r), outDec);
  const fmtOut = r => r == null ? '—' : amt(q(r), 6) + ' ' + esc(outSym);
  const perShare = r => { const v = q(r); if (!v || !ctx.usd) return ''; const sh = st.side === 'buy' ? v * Number(sk.multiplier || 1) : Number(st.amount) * Number(sk.multiplier || 1); return sh ? ` <span class="faint">${usd(st.side === 'buy' ? ctx.usd / sh : (v * (outSym === 'SOL' ? ctx.solUsd : 1)) / sh, { compact: false })}/share</span>` : ''; };
  const best = ven.filter(v => v.out).reduce((a, v) => !a || BigInt(v.out) > BigInt(a.out) ? v : a, null);
  const win = dec?.useRfq, head = !rfq || rfq.none ? ['', 'No market-maker quote', esc(rfq?.none || 'JupiterZ did not answer.') + ' Our route is used.'] : win ? ['ok', 'The market maker wins', 'Its firm price beats our route and passes every check.'] : ['warn', 'Our route wins', 'The maker\'s price does not pass every check below, so the server would use the route.'];
  const capHtml = cap && !cap.pending ? (cap.capacity ? `<div class="card"><h2>How much the maker fills</h2><div class="pad sum">
      <div><span>At or better than the route, up to</span><b>${amt(fromRaw(cap.capacity.in, inDec), 2)} ${esc(st.side === 'buy' ? st.pay : stock.symbol)}</b></div>
      <div><span>Edge on that part</span><b class="${cls(cap.capacity.edgeBps)}">${(cap.capacity.edgeBps / 100).toFixed(2)}%</b></div>
      ${cap.split ? `<div><span>Suggested split</span><b>maker ${amt(fromRaw(cap.split.makerIn, inDec), 2)} + ${esc(cap.split.restVia)} ${amt(fromRaw(cap.split.restIn, inDec), 2)}</b></div><div><span>Split gives</span><b>${fmtOut(cap.split.total)} <span class="${cls(cap.split.gainBps)}">${cap.split.gainBps >= 0 ? '+' : ''}${(cap.split.gainBps / 100).toFixed(2)}% vs route only</span></b></div>` : ''}</div></div>`
      : `<div class="card pad">${note('', 'Maker capacity', esc(cap.none || cap.error || ''))}</div>`) : '';
  return `<div class="card pad" style="display:grid;gap:12px">${note(head[0], head[1], head[2])}
      <div class="kpis" style="margin:0"><div class="card kpi"><small>Market maker (JupiterZ)</small><b>${rfq && !rfq.none ? fmtOut(rfq.out) : '—'}</b><span class="faint" style="font-size:12px">${rfq && !rfq.none ? `fee ${(rfq.feeBps ?? 0) / 100}% · firm until ${new Date(rfq.expireAt * 1000).toLocaleTimeString()}` : 'no quote'}</span></div>
        <div class="card kpi"><small>Our route</small><b>${build?.out ? fmtOut(build.out) : '—'}</b><span class="faint" style="font-size:12px">${build?.minOut ? 'at least ' + fmtOut(build.minOut) + ' after slippage' : esc(build?.error || '')}</span></div>
        <div class="card kpi"><small>Share price now</small><b>${sk.sharePrice ? usd(sk.sharePrice, { compact: false }) : '—'}</b><span class="faint" style="font-size:12px">${esc(sk.symbol || stock.symbol)} · ${esc(sk.issuer || stock.issuer)}${sk.paused ? ' · issuer paused' : ''}</span></div></div>
      ${dec?.reasons?.length ? `<div class="sum">${dec.reasons.map(r => `<div><span>${esc(r.text)}</span><b class="${r.ok ? 'up' : 'down'}">${r.ok ? 'Yes' : 'No'}</b></div>`).join('')}</div>` : ''}
      <a class="btn" href="#/t/solana/${esc(stock.mint)}">Trade ${esc(stock.symbol)}: the server takes the maker's price when it wins</a></div>
    ${capHtml}
    <div class="card"><h2>Every venue for ${esc(st.amount)} ${esc(st.side === 'buy' ? st.pay : stock.symbol)}</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Venue</th><th class="num">You get</th><th class="num hide-s">Fee</th><th class="num hide-s">Impact</th><th class="hide-s">Path</th></tr></thead><tbody>
      ${ven.map(v => `<tr style="cursor:default"><td><b>${esc(v.name)}</b>${best && v.id === best.id ? ' <span class="up" style="font-size:12px">best</span>' : ''}<br><small class="faint">${esc(v.kind || '')}</small></td><td class="num">${v.out ? fmtOut(v.out) + perShare(v.out) : `<span class="faint">${esc(v.none || 'no quote')}</span>`}</td><td class="num hide-s">${v.feeBps != null ? (v.feeBps / 100).toFixed(2) + '%' : '—'}</td><td class="num hide-s ${(v.impactPct ?? 0) > 1 ? 'down' : ''}">${v.impactPct != null ? Number(v.impactPct).toFixed(2) + '%' : '—'}</td><td class="hide-s faint" style="font-size:12px">${esc((v.labels || []).join(', '))}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}
async function rfqEvm(st) {
  const r = await page('/api/sol/rfq/evm', { chain: st.chain, symbol: st.symbol, side: st.side, amount: Number(st.amount) });
  const outDec = st.side === 'buy' ? r.decimals : 18, outSym = st.side === 'buy' ? r.symbol : r.native, vs = r.venues || [];
  const best = vs.filter(v => v.out).reduce((a, v) => !a || BigInt(v.out) > BigInt(a.out) ? v : a, null);
  const val = o => { const v = fromRaw(o, outDec); return v == null ? null : st.side === 'buy' ? v * Number(r.multiplier || 1) * (r.refUsd || 0) : v * (r.nativeUsd || 0); };
  return `<div class="card pad" style="display:grid;gap:12px">${note('', `${esc(r.symbol)} on ${esc(r.label)}`, `The server trades it through ${esc(r.server?.venue || r.serverRoute || 'its default route')}${r.server?.capNative ? `, up to ${r.server.capNative} ${esc(r.native)} per trade` : ''}. Share price now ${r.refUsd ? usd(r.refUsd, { compact: false }) : 'unknown'}.`)}
      ${best ? `<div class="kpis" style="margin:0"><div class="card kpi"><small>Best venue</small><b>${esc(best.name)}</b><span class="faint" style="font-size:12px">${amt(fromRaw(best.out, outDec), 6)} ${esc(outSym)}${val(best.out) ? ' · ' + usd(val(best.out)) : ''}</span></div><div class="card kpi"><small>You ${st.side === 'buy' ? 'pay' : 'sell'}</small><b>${esc(st.amount)} ${esc(st.side === 'buy' ? r.native : r.symbol)}</b><span class="faint" style="font-size:12px">${st.side === 'buy' && r.nativeUsd ? usd(Number(st.amount) * r.nativeUsd) : ''}</span></div></div>` : note('warn', 'No venue quoted this size', '')}
      <a class="btn" href="#/t/${esc(st.chain)}/${esc(r.token)}">Trade ${esc(r.symbol)} on ${esc(r.label)}</a></div>
    <div class="card"><h2>Every venue</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Venue</th><th class="num">You get</th><th class="num hide-s">Fee</th><th class="num hide-s">Gas</th><th class="num hide-s">Impact</th><th class="hide-s">Path</th></tr></thead><tbody>
      ${vs.map(v => `<tr style="cursor:default"><td><b>${esc(v.name)}</b>${best && v === best ? ' <span class="up" style="font-size:12px">best</span>' : ''}${v.kind === 'rfq' || /rfq|bebop|0x|uniswapx/i.test(v.name) ? '<br><small class="faint">firm quote</small>' : ''}</td><td class="num">${v.out ? `${amt(fromRaw(v.out, outDec), 6)} ${esc(outSym)}${val(v.out) ? `<br><small class="faint">${usd(val(v.out))}</small>` : ''}` : `<span class="faint">${esc(v.none || v.error || 'no quote')}</span>`}</td><td class="num hide-s">${v.feeBps != null ? (v.feeBps / 100).toFixed(2) + '%' : '—'}</td><td class="num hide-s">${v.gasUsd != null ? usd(v.gasUsd, { compact: false }) : '—'}</td><td class="num hide-s ${(v.impactPct ?? 0) > 1 ? 'down' : ''}">${v.impactPct != null ? Number(v.impactPct).toFixed(2) + '%' : '—'}</td><td class="hide-s faint" style="font-size:12px">${esc(v.path || '')}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

/* Alerts */
V.alerts = (main) => {
  const mine = store.get('alerts', []);
  main.innerHTML = `<div class="page"><div class="ph"><div><h1>Price alerts</h1><p>Get a notice here when a token crosses a price. Alerts run on the server, so they fire while this page is open on any device.</p></div></div>
    <div class="grid2"><div class="card"><h2>Your alerts</h2><div id="alist" class="pad">${mine.length ? mine.map((a, i) => `<div class="step" style="grid-template-columns:auto 1fr auto"><span>${badge(a.chain)}</span><div><b>${esc(a.symbol)} ${a.direction === 'above' ? 'rises above' : 'falls below'} ${usd(+a.usd, { compact: false })}</b><small>Set ${new Date(a.at).toLocaleString()}</small></div><button class="btn sm" data-del="${i}">Remove</button></div>`).join('') : '<div class="empty"><b>No alerts yet</b></div>'}</div></div>
    <form class="card form" id="aform"><h2 style="padding:0;font-size:15px">New alert</h2>
      <label class="field"><span>Token address</span><span class="input"><input id="aaddr" placeholder="Paste the token address" spellcheck="false"></span></label>
      <label class="field"><span>Chain</span><span class="input"><select id="achain">${S.served.map(c => `<option value="${c}">${esc(CH[c].label)}</option>`).join('')}</select></span></label>
      <div class="seg" id="adir"><button type="button" data-d="above" aria-selected="true">Rises above</button><button type="button" data-d="below" aria-selected="false">Falls below</button></div>
      <label class="field"><span>Price</span><span class="input"><span class="unit">$</span><input id="ausd" inputmode="decimal"></span></label>
      <div id="aout"></div><button class="btn primary block">Create alert</button></form></div></div>`;
  let dir = 'above'; $$('#adir button').forEach(b => b.onclick = () => { dir = b.dataset.d; $$('#adir button').forEach(x => x.setAttribute('aria-selected', String(x === b))); });
  $$('[data-del]').forEach(b => b.onclick = async () => { const a = mine[+b.dataset.del]; try { await v1(a.chain, 'DELETE', `/v1/alerts/${encodeURIComponent(a.id)}`); } catch { /* already fired or gone */ } store.set('alerts', mine.filter((_, i) => i !== +b.dataset.del)); route(); });
  $('#aform').onsubmit = async e => {
    e.preventDefault(); const out = $('#aout'), chain = $('#achain').value, addr = $('#aaddr').value.trim(), px = +$('#ausd').value;
    try {
      if (!addr) throw new Error('Paste the token address.'); if (!(px > 0)) throw new Error('Set a price above zero.');
      const m = (await loadMeta(chain, [addr]))(addr), nat = S.natives[chain];
      if (m.decimals == null || !nat) throw new Error('Could not read this token on ' + CH[chain].label + ' to convert the price.');
      // the server compares in raw native units per raw token unit
      const threshold = px / nat * 10 ** CH[chain].dec / 10 ** m.decimals;
      const r = await v1(chain, 'POST', '/v1/alerts', { token: addr, direction: dir, threshold, oneShot: true });
      mine.push({ id: r.id, chain, token: addr, symbol: m.symbol || short(addr), direction: dir, usd: String(px), at: Date.now() }); store.set('alerts', mine);
      toast('ok', 'Alert created', `${m.symbol || short(addr)} ${dir} ${usd(px, { compact: false })}`); route();
    } catch (err) { out.innerHTML = note('err', 'Not created', esc(err.message)); }
  };
};

/* Account / setup */
V.setup = async (main) => {
  const P = () => window.MintPrivy, s = () => P()?.session;
  main.innerHTML = `<div class="page"><div class="ph"><div><h1>Account</h1><p>Three steps, once: connect to your trading server, log in with Privy, then allow trading and link each chain.</p></div></div>
    <div class="grid2"><div class="card"><div class="steps" id="steps"></div></div>
    <div style="display:grid;gap:16px"><div class="card form"><h2 style="padding:0;font-size:15px">Settings</h2><div id="sets" class="muted">Add your API key to change settings.</div></div>
    <div class="card form"><h2 style="padding:0;font-size:15px">Quick-buy sizes</h2>${IDS.map(c => `<label class="field"><span>${badge(c)} ${esc(CH[c].label)}</span><span class="input"><input data-q="${c}" inputmode="decimal" value="${esc(S.quick[c])}"><span class="unit">${CH[c].native}</span></span></label>`).join('')}</div></div></div></div>`;
  $$('[data-q]').forEach(i => i.onchange = () => { S.quick[i.dataset.q] = i.value.trim(); store.set('quick', S.quick); toast('ok', 'Saved'); });
  const step = (n, done, title, body, action) => `<div class="step ${done ? 'done' : ''}"><span class="n">${done ? '✓' : n}</span><div><b>${title}</b><small>${body}</small></div><div>${action || ''}</div></div>`;
  const draw = () => {
    const ss = s(), linkedAll = S.served.every(c => S.wallets[c]?.linked);
    $('#steps').innerHTML =
      step(1, !!S.key && !Object.values(S.wallets).some(w => w.error === 401), 'Connect to your trading server', S.key ? 'API key saved in this browser.' : 'Paste the API key your server operator gave you.',
        `<form id="kform" style="display:flex;gap:6px"><span class="input" style="min-height:34px"><input id="kin" type="password" placeholder="${S.key ? '••••••••' : 'API key'}" autocomplete="off" style="padding:6px 0;width:150px"></span><button class="btn sm">${S.key ? 'Replace' : 'Save'}</button></form><label class="check" style="margin-top:6px"><input type="checkbox" id="krem" ${(() => { try { return localStorage.getItem('mint.key') ? 'checked' : ''; } catch { return ''; } })()}> Remember on this device</label>`) +
      step(2, !!ss?.authenticated, 'Log in with Privy', ss?.authenticated ? `Signed in${ss.email ? ' as ' + esc(ss.email) : ''}. Solana ${esc(short(ss.solAddress) || 'none yet')}, EVM ${esc(short(ss.evmAddress) || 'none yet')}.` : ss?.ready === false || !ss ? 'Loading Privy…' : 'Your wallets live in Privy; the server never holds their keys.',
        ss?.authenticated ? `${!ss.solAddress ? '<button class="btn sm" id="pcs">Create Solana wallet</button> ' : ''}${!ss.evmAddress ? '<button class="btn sm" id="pce">Create EVM wallet</button> ' : ''}<button class="btn sm ghost" id="plo">Log out</button>` : ss ? '<button class="btn sm primary" id="pli">Log in</button>' : '') +
      step(3, linkedAll, 'Allow trading and link each chain', 'Privy asks you to let the server sign trades inside each chain\'s limits, then you sign one message per chain to link it. Nothing moves funds.',
        '') + `<div style="display:grid;gap:8px">${S.served.map(c => { const w = S.wallets[c] || {}; return `<div class="step ${w.active ? 'done' : ''}" style="grid-template-columns:auto 1fr auto"><span>${badge(c)}</span><div><b>${esc(CH[c].label)}</b><small>${w.linked ? esc(short(w.address)) + (w.active ? ' · trading active' : ' · ' + esc(w.why || 'not active')) : w.error ? `<span class="down">${esc(w.why || 'The server did not answer.')}</span>` : esc(w.why || 'Not linked.')}</small></div><div>${S.key && ss?.authenticated ? `<button class="btn sm" data-allow="${c}">Allow</button> <button class="btn sm primary" data-link="${c}">${w.linked ? 'Relink' : 'Link'}</button>` : ''}</div></div>`; }).join('')}</div><div id="sout"></div>`;
    const kf = $('#kform'); kf.onsubmit = async e => { e.preventDefault(); const v = $('#kin').value.trim(); if (!v) return; S.key = v; try { sessionStorage.setItem('mint.key', v); if ($('#krem').checked) localStorage.setItem('mint.key', v); else localStorage.removeItem('mint.key'); } catch { /* blocked */ } await loadAccount(); startStreams(); draw(); sets(); toast(Object.values(S.wallets).some(w => w.error === 401) ? 'err' : 'ok', Object.values(S.wallets).some(w => w.error === 401) ? 'That key was refused' : 'Connected'); };
    $('#krem').onchange = e => { try { if (e.target.checked && S.key) localStorage.setItem('mint.key', S.key); else localStorage.removeItem('mint.key'); } catch { /* blocked */ } };
    if ($('#pli')) $('#pli').onclick = () => s().login(); if ($('#plo')) $('#plo').onclick = () => s().logout();
    if ($('#pcs')) $('#pcs').onclick = () => s().createSol().catch(e => toast('err', 'Not created', e.message)); if ($('#pce')) $('#pce').onclick = () => s().createEvm().catch(e => toast('err', 'Not created', e.message));
    $$('[data-allow]').forEach(b => b.onclick = () => allow(b.dataset.allow, b)); $$('[data-link]').forEach(b => b.onclick = () => link(b.dataset.link, b));
  };
  const out = (k, t, b) => { const o = $('#sout'); if (o) o.innerHTML = note(k, t, b); };
  const allow = async (c, b) => {
    const ss = s(), cfg = S.cfg || {}; b.disabled = true;
    try {
      if (c === 'solana') { if (!ss.solAddress) throw new Error('Create your Solana wallet first.'); if (!cfg.privySolanaPolicyId) throw new Error('This server has no Solana trading policy set (PRIVY_SOLANA_POLICY_ID).'); out('', 'Waiting for Privy', 'Approve the request in the Privy window.'); await P().allow(ss.solAddress, cfg.privySignerId, cfg.privySolanaPolicyId); }
      else { if (!ss.evmAddress) throw new Error('Create your EVM wallet first.'); const ids = [...new Set(Object.values(cfg.privyEvmPolicyIds || {}))]; if (ids.length !== 1) throw new Error('Privy allows one trading policy per wallet, and this server has ' + (ids.length ? 'several' : 'none') + '. Set PRIVY_EVM_POLICY_ID on the server.'); out('', 'Waiting for Privy', 'Approve the request in the Privy window. One approval covers Base, Robinhood and BNB.'); await P().allow(ss.evmAddress, cfg.privySignerId, ids); }
      out('ok', 'Allowed', 'Now link the wallet on this chain.');
    } catch (e) { out('err', 'Not allowed', esc(e.message)); }
    b.disabled = false;
  };
  const link = async (c, b) => {
    const ss = s(); b.disabled = true;
    try {
      const address = c === 'solana' ? ss.solAddress : ss.evmAddress; if (!address) throw new Error('Create the wallet first.');
      out('', 'Linking', 'Step 1 of 2: asking the server for a one-time message…');
      const { message } = await v1(c, 'POST', '/v1/wallet/link/start', { address });
      out('', 'Linking', 'Step 2 of 2: approve the message in Privy. It moves no funds.');
      let signature;
      if (c === 'solana') { const w = S.solWallet; if (!w) throw new Error('Privy has not shared your Solana wallet yet. Wait a second and try again.'); const acc = w.accounts[0]; const [m] = await w.features['solana:signMessage'].signMessage({ account: acc, message: new TextEncoder().encode(message) }); signature = btoa(String.fromCharCode(...m.signature)); }
      else signature = await P().evm.sign(message);
      const w = await v1(c, 'POST', '/v1/wallet/link/finish', { address, signature }); S.wallets[c] = w;
      out(w.active ? 'ok' : 'warn', w.active ? 'Linked and active on ' + CH[c].label : 'Linked, not active yet', esc(w.why || '')); renderWalletBtn(); startStreams(); draw();
    } catch (e) { out('err', 'Not linked', esc(e.message)); }
    b.disabled = false;
  };
  const sets = async () => {
    const el = $('#sets'); if (!S.key || !S.wallets.solana?.linked) { el.innerHTML = '<span class="muted">Link Solana to change trading settings.</span>'; return; }
    try {
      const st = await v1('solana', 'GET', '/v1/settings');
      el.innerHTML = `<label class="check"><input type="checkbox" id="smev" ${st.mevProtection ? 'checked' : ''}> MEV protection on Solana (send privately through Jito)</label><label class="field"><span>Risky tokens</span><span class="input"><select id="ssafe">${[['block', 'Refuse to buy them'], ['warn', 'Warn me'], ['off', 'No check']].map(([v, l]) => `<option value="${v}" ${st.tokenSafety === v ? 'selected' : ''}>${l}</option>`).join('')}</select></span></label>`;
      $('#smev').onchange = e => v1('solana', 'PATCH', '/v1/settings', { mevProtection: e.target.checked }).then(() => toast('ok', 'Saved')).catch(er => toast('err', 'Not saved', er.message));
      $('#ssafe').onchange = e => v1('solana', 'PATCH', '/v1/settings', { tokenSafety: e.target.value }).then(() => toast('ok', 'Saved')).catch(er => toast('err', 'Not saved', er.message));
    } catch (e) { el.innerHTML = `<span class="muted">${esc(e.message)}</span>`; }
  };
  draw(); sets();
  const onP = () => { if (S.view === 'setup') draw(); }; window.addEventListener('mintprivy', onP); S.cleanup = [...(S.cleanup || []), () => window.removeEventListener('mintprivy', onP)];
};

/* ---------- boot ---------- */
async function boot() {
  renderChains(); renderPause(); setLive(null, 'Connecting');
  try { const c = await (await fetch('/v1/chains')).json(); S.served = (c.chains || []).map(x => x.id).filter(id => CH[id]); } catch { S.served = []; }
  if (!S.served.length) { S.served = IDS; setLive(false, 'Trading server not reached'); }
  try { S.cfg = await (await fetch('/api/sol/config')).json(); } catch { S.cfg = {}; }
  route(); refreshNatives(); setInterval(refreshNatives, 60000);
  await loadAccount(); startStreams(); if (S.view !== 'token') route();
  // Privy, headless: login state and signing for Setup, quick bridge and links
  if (S.cfg.privyAppId && S.cfg.privyBundle) {
    const sc = document.createElement('script'); sc.src = '/privy.bundle.js';
    sc.onload = () => window.MintPrivy.mount($('#privybox'), { appId: S.cfg.privyAppId, headless: true, onWallets: ws => { S.solWallet = (ws || [])[0] || null; window.dispatchEvent(new Event('mintprivy')); } });
    document.head.append(sc);
  }
}
boot();
})();
