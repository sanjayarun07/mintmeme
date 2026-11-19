// The key dashboard page. Everything from the server is put in the page with textContent (labels and user ids are never parsed as HTML).
// A new key's secret lives only in this page's memory and in the reveal panel until "I saved it"; it is never stored in the browser.
const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); for (const k of kids) e.append(k); return e; };
let info = null, token = '', shown = null;
try { token = sessionStorage.getItem('keys-admin-token') || ''; } catch { /* storage off */ }

async function call(method, path, body) {
  const r = await fetch(path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-admin-token': token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j?.error?.message || `HTTP ${r.status}`); e.code = j?.error?.code; throw e; }
  return j;
}
function toast(t) { const n = $('toast'); n.textContent = t; n.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { n.hidden = true; }, 1800); }

// theme: system by default, a click pins the other one for this browser
const root = document.documentElement;
try { const t = localStorage.getItem('keys-theme'); if (t) root.dataset.theme = t; } catch { /* storage off */ }
$('theme').onclick = () => { const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; root.dataset.theme = dark ? 'light' : 'dark'; try { localStorage.setItem('keys-theme', root.dataset.theme); } catch { /* storage off */ } };

function showStatus(s) {
  const p = $('status'), t = $('status-t');
  p.classList.toggle('ok', !!s?.reachable && !!s.chains); p.classList.toggle('bad', !s?.reachable);
  t.textContent = !s?.reachable ? `${info.apiUrl} is not reachable` : s.chains ? `${info.apiUrl} · ${s.chains.map(c => c.id).join(', ')}` : `${info.apiUrl} · up`;
  p.title = t.textContent;
}

const fmt = iso => { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
function renderKeys(keys) {
  const rows = $('rows'); rows.replaceChildren();
  $('count').textContent = keys.length ? `${keys.length} key${keys.length === 1 ? '' : 's'}` : '';
  $('empty').hidden = keys.length > 0;
  for (const k of [...keys].reverse()) {
    const act = el('td', { className: 'act' });
    const revoke = el('button', { className: 'btn sm ghost', type: 'button', textContent: 'Revoke' });
    revoke.setAttribute('aria-label', `Revoke the key of ${k.userId}${k.label ? ` (${k.label})` : ''}`);
    revoke.onclick = () => {
      const sure = el('button', { className: 'btn sm danger', type: 'button', textContent: 'Revoke', title: 'Apps and MCP servers using this key stop working within about 2 seconds' }), no = el('button', { className: 'btn sm ghost', type: 'button', textContent: 'Keep' });
      sure.setAttribute('aria-label', `Confirm: revoke the key of ${k.userId}. Apps and MCP servers using it stop working.`);
      const q = el('span', { className: 'muted', textContent: 'Stop this key? ' }); q.style.marginRight = '8px';
      no.onclick = () => act.replaceChildren(revoke);
      sure.onclick = async () => { sure.disabled = true; try { await call('DELETE', `/api/keys/${k.hash}`); toast('Key revoked'); await loadKeys(); } catch (e) { q.textContent = e.message + ' '; q.className = 'err'; sure.disabled = false; } };
      act.replaceChildren(q, sure, document.createTextNode(' '), no); sure.focus();
    };
    act.append(revoke);
    rows.append(el('tr', {},
      el('td', { textContent: k.label || '—', className: k.label ? '' : 'muted' }),
      el('td', { className: 'mono', textContent: k.userId }),
      el('td', {}, el('span', { className: `badge ${k.scope}`, textContent: k.scope[0].toUpperCase() + k.scope.slice(1) })),
      el('td', { className: 'hide-sm muted', textContent: fmt(k.createdAt) }),
      el('td', { className: 'hide-sm mono muted', textContent: k.hash.slice(0, 12), title: 'First characters of the key\'s SHA-256 hash (the key itself is not stored)' }),
      act));
  }
}
async function loadKeys() { renderKeys((await call('GET', '/api/keys')).keys); }

// snippets for a new key: the HTTP API and the MCP server
function snippets(secret, key) {
  const chain = info.server?.default || 'solana', mcpEnv = { MEME_API_URL: info.apiUrl, MEME_API_KEY: secret, RFQ_DESK_URL: info.deskUrl, ...(key.scope === 'app' ? { MEME_USER_ID: '<end user id>' } : {}) };
  const q = s => /^[A-Za-z0-9_./:@=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    { id: 'curl', label: 'HTTP API', text: `curl -s ${info.apiUrl}/v1/chains\ncurl -s -H ${q('Authorization: Bearer ' + secret)}${key.scope === 'app' ? " -H 'X-User-Id: <end user id>'" : ''} ${info.apiUrl}/v1/${chain}/overview`, hint: 'Every chain is under /v1/<chain>/. See docs/HTTP_API.md.' },
    { id: 'code', label: 'Claude Code', text: `claude mcp add --transport stdio memedesk ${Object.entries(mcpEnv).map(([k, v]) => `--env ${k}=${q(v)}`).join(' ')} -- ${q(info.node)} --experimental-transform-types --no-warnings ${q(info.mcpMain)}`, hint: 'Run once in a terminal. Needs npm run mcp:install. See docs/MCP.md.' },
    { id: 'desktop', label: 'Claude Desktop', text: JSON.stringify({ mcpServers: { memedesk: { command: info.node, args: ['--experimental-transform-types', '--no-warnings', info.mcpMain], env: mcpEnv } } }, null, 2), hint: 'Merge into ~/Library/Application Support/Claude/claude_desktop_config.json, then restart Claude Desktop.' },
    { id: 'env', label: '.env', text: `MEME_API_URL=${info.apiUrl}\nMEME_API_KEY=${secret}${key.scope === 'app' ? '\nMEME_USER_ID=<end user id>' : ''}`, hint: 'For npm run mcp, the SDK client (MemeClient) or your own app. Keep it out of git.' },
  ];
}
function reveal(secret, key) {
  shown = { secret, list: snippets(secret, key) };
  $('secret').textContent = secret;
  const tabs = $('snip-tabs'); tabs.replaceChildren();
  const pick = i => { [...tabs.children].forEach((b, j) => { b.setAttribute('aria-selected', String(i === j)); b.tabIndex = i === j ? 0 : -1; }); $('snip').textContent = shown.list[i].text; $('snip-hint').textContent = shown.list[i].hint; };
  shown.list.forEach((s, i) => { const b = el('button', { type: 'button', textContent: s.label }); b.setAttribute('role', 'tab'); b.onclick = () => pick(i); b.onkeydown = e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const n = (i + (e.key === 'ArrowRight' ? 1 : shown.list.length - 1)) % shown.list.length; pick(n); tabs.children[n].focus(); } }; tabs.append(b); });
  pick(0); $('reveal').hidden = false; $('reveal').scrollIntoView({ block: 'nearest' }); $('reveal').querySelector('[data-copy=secret]').focus();
}
$('done').onclick = () => { shown = null; $('secret').textContent = ''; $('snip').textContent = ''; $('snip-tabs').replaceChildren(); $('reveal').hidden = true; $('user').focus(); };
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-copy]'); if (!b || !shown) return;
  const text = b.dataset.copy === 'secret' ? shown.secret : $('snip').textContent;
  try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { const r = document.createRange(); r.selectNodeContents(b.dataset.copy === 'secret' ? $('secret') : $('snip')); getSelection().removeAllRanges(); getSelection().addRange(r); toast('Selected: press Cmd+C'); }
});

$('new').onsubmit = async e => {
  e.preventDefault(); const user = $('user'), errEl = $('new-err'), btn = $('create');
  errEl.textContent = ''; user.removeAttribute('aria-invalid');
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(user.value.trim())) { user.setAttribute('aria-invalid', 'true'); errEl.textContent = 'Enter a user id: letters, digits, dots, dashes or underscores.'; user.focus(); return; }
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const r = await call('POST', '/api/keys', { userId: user.value.trim(), scope: new FormData($('new')).get('scope'), label: $('label').value });
    reveal(r.secret, r.key); $('label').value = ''; await loadKeys();
  } catch (x) { errEl.textContent = x.message; } finally { btn.disabled = false; btn.textContent = 'Create key'; }
};

$('token-form').onsubmit = async e => { e.preventDefault(); token = $('token').value; try { sessionStorage.setItem('keys-admin-token', token); } catch { /* storage off */ } $('token-err').textContent = ''; await start(); };

async function start() {
  try { info = await call('GET', '/api/info'); }
  catch (e) { if (e.code === 'admin_token') { $('token-card').hidden = false; if (token) $('token-err').textContent = 'That token is not right.'; $('token').focus(); return; } $('status-t').textContent = e.message; return; }
  $('token-card').hidden = true; $('new-card').hidden = false; $('list-card').hidden = false;
  showStatus(info.server);
  $('foot').replaceChildren(el('div', { textContent: `Keys file: ${info.file}` }), el('div', { textContent: 'Only SHA-256 hashes are stored. Every node of a cluster needs the same file.' }));
  await loadKeys();
  setInterval(async () => { try { const i = await call('GET', '/api/info'); info.server = i.server; showStatus(i.server); } catch { /* next time */ } }, 15000);
}
start();
