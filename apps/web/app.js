/* MINT terminal: shell, shared helpers, router. Views live in views.js. */
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=x=>x==null?'–':String(x).replace(/\B(?=(\d{3})+(?!\d))/g,',');
const compact=n=>{n=Number(n);const a=Math.abs(n);return a>=1e9?(n/1e9).toFixed(2)+'B':a>=1e6?(n/1e6).toFixed(2)+'M':a>=1e3?(n/1e3).toFixed(a>=1e5?0:1)+'K':String(Math.round(n))};
const price=p=>{p=Number(p);return p>=1?p.toFixed(2):p>=.01?p.toFixed(4):p>=.0001?p.toFixed(5):p.toPrecision(3)};
const ago=m=>m==null?'–':m<1?'under 1m':m<60?m+'m':m<1440?Math.round(m/60)+'h':Math.round(m/1440)+'d';
const short=a=>a&&a.length>14?a.slice(0,6)+'…'+a.slice(-4):a;

/* ---------- state ---------- */
const store={get(k,d){try{const v=localStorage.getItem('mint.'+k);return v==null?d:JSON.parse(v)}catch{return d}},set(k,v){try{localStorage.setItem('mint.'+k,JSON.stringify(v))}catch{}}};
const S={view:'discover',ov:null,ovAt:0,online:true,loadedOnce:false,private:store.get('private',false),paused:false,token:'0xMEME',side:'buy',slip:300,amt:'',wallet:'w1',
  watch:new Set(store.get('watch',[])),oneClick:store.get('oneClick',null),hist:{},risk:{},notes:[],unread:0,lastNote:0,auto:true,cid:null,lastTx:null,
  f:{chain:'all',pad:'all',age:'any',liq:0,vol:0,owner:'any',tax:'any',sort:'liq'},sample:SAMPLE_TOKENS.map(t=>({...t})),frozen:false,sources:store.get('sources',SAMPLE_SOURCES),theme:store.get('theme','dark')};
document.documentElement.dataset.theme=S.theme;
document.body.classList.toggle('private',S.private);

async function api(p,b){
  try{
    const r=await fetch(p,b!==undefined?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}:undefined);
    const j=await r.json();setOnline(true);return j;
  }catch(e){setOnline(false);throw e}
}
async function act(p,b){try{const r=await api(p,b);if(r&&r.ok===false)toast('error',r.title,`${r.why} ${r.fix}`);return r}catch{toast('error','Could not reach the terminal','The request did not go through, so nothing changed. Check that the server is running, then try again.');return{ok:false}}}
function setOnline(v){if(S.online!==v){S.online=v;drawStatus();drawBanner()}}

/* ---------- mode + units ---------- */
/* Simulator: integer SIM and integer token units. Real-node (overview.simulated===false): raw base units, shown with the decimals in overview.live.units. */
const isLive=()=>!!S.ov&&S.ov.simulated===false;
const NET=()=>isLive()?'Local Ethereum fork':'Practice network';
const MODE=()=>isLive()?'local fork mode':'practice mode';
const QSYM=()=>isLive()?S.ov.live.units.NATIVE.sym:'SIM';
const tokSymOf=id=>S.ov?.tokens.find(t=>t.address===id)?.sym||'?';
function U(id){const mk=u=>({sym:u.sym,dec:u.decimals??0});if(id==='native'||id==='SIM')return isLive()?mk(S.ov.live.units.NATIVE):{sym:'SIM',dec:0};return isLive()?(S.ov.live.units[id]?mk(S.ov.live.units[id]):{sym:tokSymOf(id),dec:0}):{sym:tokSymOf(id),dec:0}}
function decStr(raw,d,maxFrac){raw=BigInt(raw);if(!d)return fmt(raw);const neg=raw<0n;if(neg)raw=-raw;const base=10n**BigInt(d);let f=(raw%base).toString().padStart(d,'0').slice(0,maxFrac??(d>=12?6:2)).replace(/0+$/,'');return(neg?'-':'')+fmt(raw/base)+(f?'.'+f:'')}
const fa=(raw,id,o={})=>{if(raw==null)return'–';const u=U(id);return decStr(raw,u.dec,o.frac)+(o.bare?'':' '+u.sym)};
function plainStr(raw,d){raw=BigInt(raw);if(!d)return String(raw);const base=10n**BigInt(d);const f=(raw%base).toString().padStart(d,'0').replace(/0+$/,'');return String(raw/base)+(f?'.'+f:'')}
/** Parse what the user typed (digits, or decimals on the real node) into base units. Returns null when it is not a valid amount. */
function toRaw(str,id){const u=U(id),s=String(str??'').trim();if(!u.dec)return/^\d+$/.test(s)?BigInt(s):null;const m=s.match(/^(\d*)(?:\.(\d*))?$/);if(!m||(!m[1]&&!m[2]))return null;const f=(m[2]||'').slice(0,u.dec).padEnd(u.dec,'0');return BigInt(m[1]||'0')*10n**BigInt(u.dec)+BigInt(f||'0')}
const UNAV={copy:'Copy trading',portfolio:'Portfolio',signals:'Signals',sniper:'Launch sniper',plan:'Plan and fees'};
const unavail=v=>isLive()&&!!UNAV[v]&&(S.ov.unavailable||[]).includes(UNAV[v]);
const quick=()=>isLive()?{buy:['0.01','0.05','0.1','0.25'],def:'0.05'}:{buy:['1000','5000','10000','25000'],def:'1000'};

/* ---------- chain / token helpers ---------- */
const chainChip=k=>{const c=CHAINS[k]||CHAINS.practice;return `<span class="chain"><i style="background:${c.color}"></i>${esc(c.name)}</span>`};
const avatar=(sym,color,sz=36)=>`<span class="av" style="background:${color};width:${sz}px;height:${sz}px" aria-hidden="true">${esc(sym.slice(0,2))}</span>`;
/** Unified token list: tradable practice tokens (from the simulator) plus clearly labelled samples. */
function allTokens(){
  const out=[];
  for(const t of (S.ov?.tokens||[])){const m=PRACTICE_META[t.address]||{col:'active',color:'#8fb4ff'};const r=S.risk[t.address];
    out.push({id:t.address,live:true,name:t.name,sym:t.sym,chain:'practice',pad:null,col:m.col,color:m.color,price:t.price,chg:null,liq:t.liquidity,vol:null,mcap:null,fdv:null,act:null,tokenAge:null,poolAge:null,
      contract:t.contract,blurb:t.blurb,open:t.open,opensAt:t.opensAtBlock,owner:null,risk:r?.r,cur:isLive()?'LIVE':'SIM',findings:[],tax:null});}
  if(S.real?.length)for(const t of S.real)out.push({...t,live:false,cur:'$'});
  else if(!isLive())for(const t of S.sample)out.push({...t,live:false,cur:'$'});
  return out;
}
const tokById=id=>allTokens().find(t=>t.id===id);
const money=(t,v)=>v==null?'–':t.cur==='LIVE'?decStr(v,18,1)+' '+QSYM():t.cur==='SIM'?compact(v)+' SIM':'$'+compact(v);
const pxs=t=>t.live?price(t.price)+' '+QSYM():t.real&&!t.price?'n/a':'$'+price(t.price);
const walletName=id=>S.ov?.wallets.find(w=>w.id===id)?.name||id;
const secret=h=>`<span class="secret">${h}</span>`;

/* ---------- small UI parts ---------- */
/** Tie a form error to the field it is about: mark it invalid, point it at the message box, move focus to it, and clear the mark as soon as the user edits it. */
function invalid(el,box){if(!el)return;el.setAttribute('aria-invalid','true');if(box&&box.id)el.setAttribute('aria-describedby',box.id);el.addEventListener('input',()=>{el.removeAttribute('aria-invalid');el.removeAttribute('aria-describedby')},{once:true});el.focus()}
function toast(level,title,body){const t=document.createElement('div');t.className='toast '+level;t.innerHTML=`<b>${esc(title)}</b><span>${esc(body)}</span>`;t.onclick=()=>t.remove();$('#toasts').append(t);setTimeout(()=>t.remove(),level==='error'?12000:7000)}
const IC={ok:'✓',warn:'!',error:'✕',info:'i',plain:'i'};
const notice=(lvl,title,body='')=>`<div class="notice ${lvl}" role="${lvl==='error'?'alert':'note'}"><span class="ic" aria-hidden="true">${IC[lvl]}</span><div>${title?`<b>${title}</b>`:''}${body}</div></div>`;
const skeleton=n=>Array.from({length:n},()=>'<div class="skel" style="height:54px;margin-bottom:10px"></div>').join('');
const realTag=(v,pad)=>pad&&LAUNCHPADS[pad]?`<span class="sample" title="Real token launched on ${LAUNCHPADS[pad].name}. Read-only: trading is off. ${esc(LAUNCHPADS[pad].rule)}">${LAUNCHPADS[pad].name} · read-only</span>`:`<span class="sample" style="${v?'':'color:var(--warn,#e0a030)'}" title="${v?'Real market data. The pool was confirmed on-chain by this app. Read-only: trading is off.':'Real market data, but this pool could not be confirmed as an official pool. Read-only.'}">${v?'Real · read-only':'Real · unverified pool'}</span>`;
const sampleTag='<span class="sample" title="Illustrative data. Not a real token, price or source.">Sample</span>';
function ctxStrip({token,chain,wallet,limit,status}){return `<div class="ctx" aria-label="Trade summary"><div><small>Token</small><b>${esc(token)}</b></div><div><small>Chain</small><b>${esc(chain)}</b></div><div><small>Wallet</small><b>${esc(wallet)}</b></div><div><small>Spend limit</small><b>${esc(limit)}</b></div><div><small>Status</small><b>${esc(status)}</b></div></div>`}
function spark(vals,w=90,h=30,color){
  if(!vals||vals.length<2)return `<svg class="spark" width="${w}" height="${h}" aria-hidden="true"></svg>`;
  const mn=Math.min(...vals),mx=Math.max(...vals),rg=(mx-mn)||1;const up=vals[vals.length-1]>=vals[0];color=color||(up?'var(--teal)':'var(--coral)');
  const pts=vals.map((v,i)=>`${(i/(vals.length-1)*(w-2)+1).toFixed(1)},${(h-3-((v-mn)/rg)*(h-6)).toFixed(1)}`).join(' ');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" points="${pts}"/></svg>`;
}
function seeded(seed,n,drift){let x=0;for(const c of seed)x=(x*31+c.charCodeAt(0))>>>0;const r=()=>(x=(x*1664525+1013904223)>>>0)/4294967296;let v=1;const o=[v];for(let i=1;i<n;i++){v*=1+(r()-.5)*.09+drift/n/100;o.push(v)}return o}

/* ---------- dialogs ---------- */
const dlg=$('#dlg');
function modal({title,body,actions=[],drawer=false,onClose}){
  dlg.className=drawer?'drawer':'';
  dlg.innerHTML=`<div class="dh"><h2>${title}</h2><button class="btn ghost sm" id="dx" aria-label="Close">Close</button></div><div class="db">${body}</div>${actions.length?`<div class="df">${actions.map((a,i)=>`<button class="btn ${a.cls||''}" data-i="${i}" ${a.disabled?'disabled':''}>${a.label}</button>`).join('')}</div>`:''}`;
  $('#dx',dlg).onclick=()=>dlg.close();
  $$('.df button',dlg).forEach(b=>b.onclick=async()=>{const a=actions[b.dataset.i];const r=a.fn?await a.fn(b):undefined;if(r!==false&&!a.keep)dlg.close()});
  dlg.onclose=()=>{onClose&&onClose()};
  if(!dlg.open)dlg.showModal();
  return dlg;
}
const closeModal=()=>dlg.open&&dlg.close();

/* ---------- shell ---------- */
const ICONS={
  discover:'<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',trade:'<path d="M4 8h14l-3-3M20 16H6l3 3"/>',copy:'<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/><path d="M16 5.5a3 3 0 0 1 0 5.5M18 14c2 .7 3 2.600 3 6"/>',
  sniper:'<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><path d="M12 1v5M12 18v5M1 12h5M18 12h5"/>',orders:'<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  portfolio:'<path d="M12 3v9h9"/><path d="M20.500 15A9 9 0 1 1 9 3.500"/>',signals:'<path d="M5 20V12M10 20V6M15 20V10M20 20V4"/>',wallets:'<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M16 15h2"/>',
  automation:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  more:'<path d="M4 7h16M4 12h16M4 17h16"/>'};
const ico=n=>`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]||'<circle cx="12" cy="12" r="3"/>'}</svg>`;
const MAIN=[['discover','Discover'],['trade','Trade'],['copy','Copy trade'],['sniper','Sniper'],['orders','Orders'],['portfolio','Portfolio'],['signals','Signals'],['wallets','Wallets'],['solana','Solana lookup']];
const MORE=[['whales','Whale alerts'],['bots','Community bots'],['referrals','Referrals'],['cashback','Cashback'],['plan','Subscriptions'],['support','Support']];
const KEYS={d:'discover',t:'trade',c:'copy',s:'sniper',o:'orders',p:'portfolio',i:'signals',w:'wallets'};
const BRAND=`<svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><path d="M3 21 11 3h5L8 21z" fill="#e4e4e4"/><path d="M12 21 19 7h4l-7 14z" fill="#2fcb73"/></svg>`;
function drawShell(){
  $('#side').innerHTML=`<div class="brand">${BRAND}MINT</div><nav aria-label="Main">${MAIN.map(([id,l])=>`<button class="nv ${unavail(id)?'na':''}" data-v="${id}" ${cur()===id?'aria-current="page"':''}>${ico(id)}${l}${unavail(id)?'<span class="chip" style="margin-left:auto;font-size:11px" title="Only in the practice simulator">Sim only</span>':''}</button>`).join('')}</nav>
  <div class="sec">More</div><nav aria-label="More">${MORE.map(([id,l])=>`<button class="nv" data-v="${id}" ${cur()===id?'aria-current="page"':''}>${l}</button>`).join('')}</nav><div class="sp"></div>
  <div class="tgbox"><span class="dot warn"></span><span>Telegram: not connected in ${MODE()}</span></div>`;
  $('#bnav').innerHTML=[['discover','Discover'],['trade','Trade'],['automation','Automation'],['portfolio','Portfolio']].map(([id,l])=>`<button data-v="${id}" ${mobTab()===id?'aria-current="page"':''}>${ico(id)}<span>${l}</span></button>`).join('');
}
const cur=()=>S.view;
const mobTab=()=>['orders','copy','sniper','signals','automation'].includes(S.view)?'automation':['discover','trade','portfolio'].includes(S.view)?S.view:'';
function drawTop(){
  $('#top').innerHTML=`<button id="menu" class="btn iconbtn ghost menubtn" aria-label="Open menu">${ico('more')}</button>
  <div class="search" role="search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><input id="q" type="search" placeholder="Search token or contract ( / )" aria-label="Search token or contract" autocomplete="off"><div class="res" id="qres" hidden></div></div>
  <div class="tools">
    <button class="btn pausebtn" id="pause" aria-pressed="${S.paused}" title="Stops automated strategies from opening new positions"><span class="lg">${S.paused?'New automated entries paused':'Pause new automated entries'}</span><span class="sm">${S.paused?'Entries paused':'Pause entries'}</span></button>
    <button class="btn hide-m" id="priv" aria-pressed="${S.private}" title="Hide balances on screen (p)">Privacy: ${S.private?'on':'off'}</button>
    <button class="btn hide-m" id="bell" aria-label="Messages">Messages${S.unread?` <span class="chip bad">${S.unread}</span>`:''}</button>
    <button class="btn hide-m" id="th" aria-label="Switch to ${S.theme==='dark'?'light':'dark'} theme" title="Switch theme">${S.theme==='dark'?'☀':'☾'}</button>
    <button class="btn primary" id="dep">Deposit</button></div>`;
  $('#priv').onclick=()=>setPrivate(!S.private);$('#th').onclick=()=>{S.theme=S.theme==='dark'?'light':'dark';store.set('theme',S.theme);document.documentElement.dataset.theme=S.theme;drawTop()};
  $('#bell').onclick=showMessages;$('#dep').onclick=()=>go('wallets',{flow:'fund'});$('#pause').onclick=pauseDialog;
  $('#menu').onclick=()=>$('#side').classList.toggle('open');
  const q=$('#q');q.oninput=()=>searchDraw(q.value);q.onkeydown=e=>{if(e.key==='Escape'){q.value='';$('#qres').hidden=true}};q.onblur=()=>setTimeout(()=>$('#qres').hidden=true,180);q.onfocus=()=>q.value&&searchDraw(q.value);
}
function searchDraw(v){
  const r=$('#qres');v=v.trim().toLowerCase();if(!v){r.hidden=true;return}
  const hits=allTokens().filter(t=>t.sym.toLowerCase().includes(v)||t.name.toLowerCase().includes(v)||(t.contract||'').toLowerCase().includes(v)).slice(0,6);
  r.hidden=false;r.innerHTML=hits.length?hits.map(t=>`<button data-id="${t.id}">${avatar(t.sym,t.color,24)}<span style="flex:1"><b>${esc(t.sym)}</b> <span class="muted">${esc(t.name)}</span></span>${chainChip(t.chain)}${t.live?'':sampleTag}</button>`).join(''):`<div class="empty" style="padding:14px">No token matches "${esc(v)}". Paste a full contract address to look it up; unknown addresses cannot be traded.</div>`;
  $$('button',r).forEach(b=>b.onmousedown=e=>{e.preventDefault();S.token=b.dataset.id;go('trade')});
}
function setPrivate(v){S.private=v;store.set('private',v);document.body.classList.toggle('private',v);drawTop()}
function pauseDialog(){
  if(S.paused){modal({title:'Resume automated entries?',body:`<p class="muted">Orders, copy trading and the sniper may open new positions again, within their own limits.</p>`,actions:[{label:'Keep paused',cls:'ghost'},{label:'Resume entries',cls:'primary',fn:()=>setPause(false)}]});return}
  modal({title:'Pause new automated entries',body:`<div class="stack"><p>This stops every automated strategy from <b>opening new positions</b>.</p>
  <div class="notice ok"><span class="ic">✓</span><div><b>Stays active</b>Stop losses, take profits and other exits. Copy-trade exits. Your wallets and balances. Manual trades.</div></div>
  <div class="notice warn"><span class="ic">!</span><div><b>Stops</b>Limit buys, copy buys and sniper buys. Skipped buys are listed in the activity log with the reason.</div></div></div>`,
  actions:[{label:'Cancel',cls:'ghost'},{label:'Pause new entries',cls:'primary',fn:()=>setPause(true)}]});
}
async function setPause(v){const r=await act('/api/pause-entries',{paused:v});if(r.ok===false)return false;S.paused=r.paused;drawTop();drawBanner()}
function showMessages(){S.unread=0;drawTop();modal({title:'Messages',drawer:true,body:S.notes.length?S.notes.slice().reverse().map(n=>notice(n.level==='success'?'ok':n.level,esc(n.title),`<div>${esc(n.body)}</div>`)).join('<div style="height:8px"></div>'):`<div class="empty"><b>No messages yet</b>Confirmations, failures and strategy decisions appear here.</div>`})}
function drawBanner(){
  const b=[];
  if(!S.online)b.push(`<div class="banner off" role="alert"><b>Disconnected.</b> The terminal cannot reach its server. Figures below are from ${S.ovAt?Math.round((Date.now()-S.ovAt)/1000)+'s ago':'before the connection dropped'}. We keep retrying; nothing is sent while you are offline.</div>`);
  if(S.paused)b.push(`<div class="banner paused"><b>New automated entries are paused.</b> Exits and manual trades still work. <button class="btn sm" id="bresume">Resume</button></div>`);
  $('#banner').innerHTML=b.join('');const r=$('#bresume');if(r)r.onclick=pauseDialog;
}
function drawStatus(){
  const age=S.ovAt?Math.round((Date.now()-S.ovAt)/1000):null,stale=S.online&&age!=null&&age>8;
  const live=!S.online?['bad','Disconnected']:stale?['warn',`Stale: updated ${age}s ago`]:S.ovAt?['ok',`Data live · updated ${age<2?'just now':age+'s ago'}`]:['warn','Connecting…'];
  $('#status').innerHTML=`<span class="it"><span class="dot ${live[0]}"></span>${live[1]}</span><span class="grow"></span>
  <span class="it">${NET()} <span class="dot ${S.online?'ok':'bad'}"></span>${S.online?'Operational':'Unreachable'}${S.ov?` · block <b class="num">${S.ov.block}</b>`:''}</span>
  ${isLive()?'':S.real?.length?'<span class="it">Ethereum, BNB, Solana: <span class="faint">real market data, read-only (updated '+ago(Math.round((Date.now()-S.realAt)/60000))+' ago)</span></span>':'<span class="it">Solana, Ethereum, Base, BNB: <span class="faint">sample data only, no live connection</span></span>'}
  <label class="it" style="margin:0"><input type="checkbox" id="auto" style="width:auto;min-height:0" ${S.auto?'checked':''}> Add a block every 4 s</label>`;
  $('#auto').onchange=e=>S.auto=e.target.checked;
}

/* ---------- router ---------- */
const V={};
function go(v,opts={}){S.nav=opts;if(location.hash!=='#/'+v)location.hash='#/'+v;else render()}
function render(){
  const v=(location.hash.replace('#/','')||'discover');S.view=V[v]?v:'discover';const view=V[S.view];
  drawShell();$('#side').classList.remove('open');closeModal();
  const nv=document.createElement('div');nv.id='view';$('#view').replaceWith(nv);const m=nv;m.innerHTML=S.loadedOnce&&unavail(S.view)?unavailPage(view):S.loadedOnce||!view.needsData?view.html():`<div class="pagehead"><div><h1>${esc(view.title)}</h1></div></div>${skeleton(4)}`;
  document.title=`${view.title} · MINT`;view.mount&&S.loadedOnce&&!unavail(S.view)&&view.mount();if(!S.loadedOnce&&view.needsData)S.pending=true;
  $('#main').focus({preventScroll:true});$('#main').scrollTop=0;window.scrollTo(0,0);S.nav={};
}
function unavailPage(view){return `<div class="pagehead"><div><h1>${esc(view.title)}</h1></div></div><div class="panel empty"><b>${esc(view.title)} is not available on the local fork yet</b>This page only exists in the practice simulator. Nothing here is faked on the fork, so there is nothing to show.<br>Orders, Trade and Wallets work here. Run <span class="kbd">npm run web</span> for the simulator version.<br><button class="btn primary" onclick="go('orders')">Go to Orders</button></div>`}
addEventListener('hashchange',render);
document.addEventListener('click',e=>{const b=e.target.closest('[data-v]');if(b&&(b.closest('#side')||b.closest('#bnav')))go(b.dataset.v==='automation'?'automation':b.dataset.v)});
/* keyboard: "/" search, p privacy, ? help, g then letter to jump */
let gWait=0;
addEventListener('keydown',e=>{
  const tag=(e.target.tagName||'').toLowerCase();if(tag==='input'||tag==='textarea'||tag==='select'||e.metaKey||e.ctrlKey||dlg.open)return;
  if(e.key==='/'){e.preventDefault();$('#q').focus();return}
  if(e.key==='p'){setPrivate(!S.private);return}
  if(e.key==='?'){shortcuts();return}
  if(gWait&&Date.now()-gWait<1500&&KEYS[e.key]){gWait=0;go(KEYS[e.key]);return}
  gWait=e.key==='g'?Date.now():0;
});
function shortcuts(){modal({title:'Keyboard shortcuts',body:`<div class="stack">${[['/','Search tokens'],['g then d / t / c / s / o / p / i / w','Go to Discover, Trade, Copy trade, Sniper, Orders, Portfolio, Signals, Wallets'],['p','Hide or show balances'],['Esc','Close a dialog'],['Tab','Move between controls; the focus ring always shows where you are']].map(([k,d])=>`<div class="kv"><span><span class="kbd">${k}</span></span><span style="text-align:right">${d}</span></div>`).join('')}</div>`})}

/* ---------- polling ---------- */
async function loadReal(){try{const was=S.realInfo?.enabled;const r=await api('/api/markets');S.realInfo=r;if(r.enabled&&r.tokens?.length){S.real=r.tokens;S.realAt=Date.now()}if(S.loadedOnce&&(S.view==='discover'||(!was&&r.enabled&&['sniper','wallets','portfolio','copy','signals'].includes(S.view))))render()}catch{}}
async function poll(){
  if(!S.realAt||Date.now()-S.realAt>120000){S.realAt=Date.now();loadReal()}
  try{
    S.ov=await api('/api/overview');S.ovAt=Date.now();CHAINS.practice.name=NET();
    for(const t of S.ov.tokens){const h=S.hist[t.address]=S.hist[t.address]||[];if(!h.length||h[h.length-1].p!==t.price)h.push({p:t.price,t:Date.now(),block:S.ov.block});if(h.length>240)h.shift()}
    const n=await api('/api/notes?after='+S.lastNote);
    for(const x of n){S.lastNote=x.id;S.notes.push(x);if(S.loadedOnce){S.unread++;toast(x.level,x.title,x.body)}}
    if(n.length)drawTop();
    if(!S.loadedOnce){S.loadedOnce=true;const p=await api('/api/pause-entries').catch(()=>null);if(p)S.paused=p.paused;drawTop();drawBanner();render()}
    else{const v=V[S.view];v.tick&&!dlg.open&&!unavail(S.view)&&v.tick()}
  }catch{if(!S.loadedOnce)$('#view').innerHTML=`<div class="panel empty"><b>Cannot reach the terminal server</b>The local server is not answering, so no data can be shown. Start it with <span class="kbd">npm run web</span>, then retry.<br><button class="btn primary" onclick="poll()">Retry</button></div>`}
  drawStatus();
}
async function fetchRisk(id,force){if(isLive())return undefined;const c=S.risk[id];if(c&&!force&&Date.now()-c.at<30000)return c.r;try{const r=await api('/api/risk',{token:id});S.risk[id]={r,at:Date.now()};return r}catch{return c?.r}}

drawTop();drawShell();drawBanner();drawStatus();
setInterval(poll,1500);setInterval(drawStatus,1000);setInterval(()=>{if(S.auto&&S.online)api('/api/mine',{n:1}).catch(()=>{})},4000);
poll();
