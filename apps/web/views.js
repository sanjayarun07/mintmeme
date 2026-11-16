/* Views, part 1: shared helpers, Discover, Trade. */
const head=(title,desc,extra='')=>`<div class="pagehead"><div><h1>${title}</h1>${desc?`<p>${desc}</p>`:''}</div><div class="row">${extra}</div></div>`;
const practiceNote=()=>isLive()?`<div class="banner practice"><b>Local fork.</b> ${esc(S.ov.live.network)}. Prices come from the forked Uniswap V2 WETH/USDC pool; wallets hold fake ETH.</div>`:`<div class="banner practice"><span><b>Practice mode.</b> Practice network tokens trade on a local simulator with made-up funds. ${S.real?.length?`Other cards are <b>real tokens on Ethereum, BNB and Solana</b>: live market data, read-only, and they cannot be traded. Market data is from a third party; each pool is checked on-chain by this app.`:`Cards marked ${sampleTag} are illustrative and cannot be traded.`}</span></div>`;
function plainFlag(f){
  if(/sell simulation reverts/.test(f))return'A test sale was blocked by the token. You may not be able to sell it.';
  if(/buy simulation reverts/.test(f))return'A test purchase failed, so this token cannot be bought right now.';
  const m=f.match(/high transfer tax \(buy (\d+)bps, sell (\d+)bps\)/);if(m)return`High transfer tax: about ${m[1]/100}% on buys and ${m[2]/100}% on sells.`;
  const map={'mint authority active':'Mint authority is active: new supply can be created.','freeze authority active':'Freeze authority is active: wallets can be frozen.','privileged owner present':'A privileged owner can change token settings.','upgradeable':'Contract can be upgraded by its owner.','pausable':'Owner can pause transfers.','blacklist function':'Owner can block specific wallets.','top holders >50% of supply':'Top holders own more than half the supply.','liquidity concentrated in one position':'Liquidity sits in one position that can be removed.','LP mostly unlocked':'Most liquidity is not locked.','rebasing/unusual balance behavior':'Balances change unusually (rebasing).','matches known-malicious indicator':'Matches a known-malicious indicator.'};
  return map[f]||f;
}
const clk=at=>{const s=Math.round((Date.now()-at)/1000);return s<60?`${Math.max(s,1)}s ago`:`${Math.round(s/60)}m ago`};
function findingsFor(t){
  if(t.live&&isLive())return[{lvl:'info',text:'Token safety checks are not available on the local fork yet.',when:''}];
  if(!t.live)return t.findings.map(f=>({lvl:f.lvl,text:f.text,when:`Checked ${ago(f.ago)} ago`}));
  const c=S.risk[t.id];if(!c)return[{lvl:'info',text:'Running a test buy and sell…',when:''}];
  const r=c.r,when=`Tested ${clk(c.at)}`,o=[];
  if(t.open===false)return[{lvl:'warn',text:`Trading is not open yet (opens at block ${t.opensAt}), so a test buy cannot run.`,when}];
  if(r.buyTaxBps!=null){const pc=b=>b==null||Number.isNaN(Number(b))?'not measurable':`${b/100}%`;o.push({lvl:r.buyTaxBps>500||r.sellTaxBps>500||r.sellTaxBps==null?'warn':'ok',text:`Measured tax: ${pc(r.buyTaxBps)} buy, ${pc(r.sellTaxBps)} sell`,when});}
  r.flags.forEach(f=>o.push({lvl:/blocked|reverts|malicious/.test(f)?'bad':'warn',text:plainFlag(f),when}));
  if(!r.flags.length)o.push({lvl:'ok',text:'Test buy and sell both worked. This is not a guarantee.',when});
  return o;
}
const FIC={ok:'✓',warn:'!',bad:'✕',info:'i'};
/* ---------- Discover ---------- */
function taxOf(t){if(t.live){const r=S.risk[t.id]?.r;return r&&r.buyTaxBps!=null?Math.max(r.buyTaxBps,r.sellTaxBps)/100:null}return t.tax?Math.max(t.tax.buy,t.tax.sell):null}
function passes(t){
  const f=S.f;if(f.chain!=='all'&&t.chain!==f.chain)return false;if(f.pad!=='all'&&t.pad!==f.pad)return false;
  if(f.watch&&!S.watch.has(t.id))return false;
  if(f.age!=='any'){if(t.tokenAge==null)return false;if(t.tokenAge>Number(f.age))return false}
  if(f.liq&&(t.liq??0)<f.liq)return false;if(f.vol&&(t.vol??0)<f.vol)return false;
  if(f.owner!=='any'&&(t.owner||'unknown')!==f.owner)return false;
  if(f.tax!=='any'){const x=taxOf(t);if(x==null)return false;if(f.tax==='none'&&x>0)return false;if(f.tax==='low'&&x>5)return false}
  return true;
}
const OWN={renounced:'Ownership renounced',active:'Mint authority active',pause:'Owner can pause transfers',unknown:'Owner controls not checked'};
function card(t){
  const c=t.chg,iv=t.col==='new'?'1h':'24h',watched=S.watch.has(t.id);
  const hist=t.live?(S.hist[t.id]||[]).map(x=>x.p):seeded(t.id,24,c||0);
  const mig=t.col==='near'&&t.migration?`<div><div class="row sb" style="font-size:12px;color:var(--muted)"><span>${esc(LAUNCHPADS[t.pad].name)}: graduation</span><b>${t.migration.pct}%</b></div><div style="height:6px;border-radius:4px;background:var(--line2);margin-top:4px" role="progressbar" aria-valuenow="${t.migration.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Progress to graduation"><div style="height:6px;border-radius:4px;width:${t.migration.pct}%;background:var(--blue)"></div></div><div class="faint" style="font-size:11.5px;margin-top:3px">${esc(LAUNCHPADS[t.pad].rule)}</div></div>`:'';
  const age=t.live?(t.opensAt&&!t.open?`Trading opens at block ${t.opensAt}`:isLive()?'Forked Uniswap V2 pool':'Practice pool'):`Token ${ago(t.tokenAge)} · pool ${t.poolAge==null?'not created':ago(t.poolAge)}`;
  const contract=t.live?`<button class="btn ghost sm mono" data-copy="${esc(t.contract)}" title="Copy full contract address" style="min-height:24px;padding:0 6px">${short(t.contract)} ⧉</button>`:t.real?`<button class="btn ghost sm mono" data-copy="${esc(t.contract)}" title="Copy full contract address" style="min-height:24px;padding:0 6px">${short(t.contract)} ⧉</button>`:`<span class="faint" title="Sample tokens have no contract">No contract (sample)</span>`;
  return `<article class="tok ${t.live?'live':''}" data-id="${t.id}" aria-label="${esc(t.name)}">
  <div class="t1">${avatar(t.sym,t.color)}<div class="nm"><div class="row" style="gap:7px"><b>${esc(t.sym)}</b><span class="muted">${esc(t.name)}</span></div><div class="meta">${chainChip(t.chain)}${contract}</div></div>${t.live?'':t.real?realTag(t.verified,t.pad):sampleTag}
  <button class="btn sm iconbtn star" data-star="${t.id}" aria-pressed="${watched}" aria-label="${watched?'Remove from':'Add to'} watchlist: ${esc(t.sym)}" title="Watchlist">${watched?'★':'☆'}</button></div>
  <div class="px"><div><b class="num" style="font-size:19px">${pxs(t)}</b>${isLive()?' <span class="faint">per USDC</span>':''}${c!=null?` <span class="${c>=0?'up':'dn'} num">${c>=0?'▲':'▼'} ${Math.abs(c).toFixed(1)}% <span class="faint">${iv}</span></span>`:' <span class="faint">price change n/a</span>'}</div>${spark(hist,78,28)}</div>
  <div class="faint" style="font-size:12px">${age}</div>
  <div class="mx"><div><span>Liquidity</span><b class="num">${money(t,t.liq)}</b></div><div><span>Volume 24h</span><b class="num">${t.vol==null?'–':money(t,t.vol)}</b></div>
  <div title="Market cap uses circulating supply"><span>Market cap</span><b class="num">${t.mcap==null?'–':money(t,t.mcap)}</b></div><div title="Fully diluted value counts every token that will ever exist"><span>FDV</span><b class="num">${t.fdv==null?'–':money(t,t.fdv)}${t.mcap&&t.fdv&&t.fdv>t.mcap*1.2?' <span class="chip warn" title="FDV is well above market cap: much supply is not yet circulating">dilution</span>':''}</b></div></div>
  ${mig}
  <div class="finds">${findingsFor(t).map(f=>`<div class="find ${f.lvl}"><span aria-hidden="true">${FIC[f.lvl]}</span><div>${esc(f.text)}${f.when?`<small>${f.when}</small>`:''}</div></div>`).join('')}${!t.live&&!t.real&&t.owner&&t.owner!=='renounced'&&!t.findings.some(f=>/Owner|Mint/.test(f.text))?`<div class="find warn"><span>!</span><div>${OWN[t.owner]}</div></div>`:''}</div>
  <div class="acts">${t.live?`<button class="btn sm" data-trade="${t.id}">Open</button><button class="btn sm primary" data-buy="${t.id}" ${t.open===false?'disabled title="Trading is not open yet"':''}>Buy ${isLive()?quick().def+' '+QSYM():'1,000 SIM'}</button>`:`<button class="btn sm" data-trade="${t.id}">Preview</button><button class="btn sm" disabled title="${t.real?'Real market data is read-only. Trading real tokens is not enabled.':'Sample tokens cannot be traded'}">${t.real?'Trading off':'Buy unavailable'}</button>`}</div></article>`;
}
const AGE_OPTS=[['any','Any age'],['15','Under 15 min'],['60','Under 1 hour'],['1440','Under 1 day']];
V.discover={title:'Discover',needsData:true,
html(){const f=S.f;const opt=(v,l,cur)=>`<option value="${v}" ${String(cur)===String(v)?'selected':''}>${l}</option>`;
  return practiceNote()+head('Discover','Find launches, track liquidity, trade with control.',`<span class="frozen" id="frz" role="status" aria-live="polite"></span>`)+
  `<div class="pills" role="group" aria-label="Chain"><button class="pill" data-ch="all" aria-pressed="${f.chain==='all'}">All</button>${Object.entries(CHAINS).filter(([k])=>!isLive()||k==='practice').map(([k,c])=>`<button class="pill" data-ch="${k}" aria-pressed="${f.chain===k}"><i style="width:8px;height:8px;border-radius:2px;background:${c.color}"></i>${c.name}</button>`).join('')}</div>
  <details class="panel" style="margin:12px 0" ${innerWidth>860?'open':''}><summary style="cursor:pointer;font-weight:600">Filters</summary><div class="filters">
  <div><label for="fp">Launchpad</label><select id="fp">${opt('all','All launchpads',f.pad)}${Object.entries(LAUNCHPADS).map(([k,l])=>opt(k,l.name,f.pad)).join('')}</select></div>
  <div><label for="fa">Token age</label><select id="fa">${AGE_OPTS.map(([v,l])=>opt(v,l,f.age)).join('')}</select></div>
  <div><label for="fl">Minimum liquidity</label><select id="fl">${[[0,'Any'],[50e3,'50K'],[500e3,'500K'],[5e6,'5M']].map(([v,l])=>opt(v,l,f.liq)).join('')}</select></div>
  <div><label for="fv">Minimum volume 24h</label><select id="fv">${[[0,'Any'],[1e6,'1M'],[10e6,'10M']].map(([v,l])=>opt(v,l,f.vol)).join('')}</select></div>
  <div><label for="fo">Ownership controls</label><select id="fo">${[['any','Any'],['renounced','Renounced'],['active','Mint authority active'],['pause','Owner can pause'],['unknown','Not checked']].map(([v,l])=>opt(v,l,f.owner)).join('')}</select></div>
  <div><label for="ft">Transfer tax (measured)</label><select id="ft">${[['any','Any'],['none','None measured'],['low','5% or less']].map(([v,l])=>opt(v,l,f.tax)).join('')}</select></div>
  <div><label for="fw">Show</label><select id="fw">${opt('','All tokens',f.watch?'1':'')}${opt('1','Watchlist only',f.watch?'1':'')}</select></div></div></details>
  <div id="nsol"></div><div class="cols" id="cols" role="region" aria-label="Token feeds"></div>`},
mount(){
  const set=(id,k,num)=>{$(id).onchange=e=>{S.f[k]=num?Number(e.target.value):e.target.value;this.draw(true)}};
  set('#fp','pad');set('#fa','age');set('#fl','liq',1);set('#fv','vol',1);set('#fo','owner');set('#ft','tax');$('#fw').onchange=e=>{S.f.watch=!!e.target.value;this.draw(true)};
  $$('[data-ch]').forEach(b=>b.onclick=()=>{S.f.chain=b.dataset.ch;$$('[data-ch]').forEach(x=>x.setAttribute('aria-pressed',x===b));this.draw(true)});
  const cols=$('#cols'),self=this;V.sniper.live();this.strip();$('#nsol').onclick=e=>{if(e.target.closest('[data-allnew]'))go('sniper')};
  const setF=v=>{S.frozen=v;$('#frz').textContent=v?'Order is frozen while you use a card':'';if(!v)self.draw()};
  cols.addEventListener('pointerover',e=>{if(e.target.closest('.tok'))setF(true)});cols.addEventListener('pointerleave',()=>{if(!cols.contains(document.activeElement))setF(false)});
  cols.addEventListener('focusin',e=>{if(e.target.closest('.tok'))setF(true)});cols.addEventListener('focusout',()=>setTimeout(()=>{if(!cols.matches(':hover')&&!cols.contains(document.activeElement))setF(false)},50));
  cols.onclick=async e=>{const b=e.target.closest('button');if(!b)return;
    if(b.dataset.star){const id=b.dataset.star;S.watch.has(id)?S.watch.delete(id):S.watch.add(id);store.set('watch',[...S.watch]);b.setAttribute('aria-pressed',S.watch.has(id));b.textContent=S.watch.has(id)?'★':'☆'}
    else if(b.dataset.trade){S.token=b.dataset.trade;go('trade')}
    else if(b.dataset.buy){S.token=b.dataset.buy;S.side='buy';S.amt=quick().def;go('trade')}
    else if(b.dataset.copy){try{await navigator.clipboard.writeText(b.dataset.copy);toast('success','Contract copied','The full practice contract address is on your clipboard.')}catch{toast('warn','Could not copy','Select the address on the trade page and copy it manually.')}}
    else if(b.dataset.sort){S.f.sort=b.dataset.sort;this.draw(true)}};
  cols.onclick=cols.onclick.bind(this);
  this.draw(true);S.ov.tokens.forEach(t=>fetchRisk(t.address).then(()=>this.draw()));
},
draw(force){this.strip();
  if(!$('#cols')||(S.frozen&&!force))return;const all=allTokens().filter(passes),f=S.f;
  const num=(a,k)=>(a[k]??-1),sk=f.sort==='liq'?'liq':f.sort==='vol'?'vol':'act';
  // Launchpad lifecycle, left to right. Real tokens carry a stage read from the chain; practice and sample tokens use their own column field.
  const stageOf=t=>t.real?t.stage:t.col==='new'?'new':t.col==='near'&&LAUNCHPADS[t.pad]?.graduation?'almost':t.col==='active'?'market':'market';
  const inStage=k=>all.filter(t=>stageOf(t)===k);
  const colsData=[
    ['New','Launchpad tokens still on their bonding curve.',inStage('new').sort((a,b)=>(a.tokenAge??0)-(b.tokenAge??0)),isLive()?'The local fork has no launch feed. Only the forked WETH/USDC pool is listed.':'No launchpad tokens match. Widen the age filter or clear filters.'],
    ['Almost bonded','Close to graduating. Needs a published graduation rule: Four.meme at 70% or more. Pump.fun does not publish its threshold, so it never appears here.',inStage('almost').sort((a,b)=>(b.migration?.pct??0)-(a.migration?.pct??0)),isLive()?'No launchpads exist on the local fork.':'Nothing is at 70% or more of its raise target.'],
    ['Migrated','Left the curve: liquidity moved to a DEX pool (Pump.fun to PumpSwap, Four.meme to PancakeSwap).',inStage('migrated').sort((a,b)=>b.liq-a.liq),'No migrated launchpad tokens match these filters.']];
  const mk=inStage('market').sort((a,b)=>num(b,sk)-num(a,sk)),realMk=mk.filter(t=>t.real).length;
  const sorts=`<div class="pills" role="group" aria-label="Sort markets">${[['liq','Liquidity'],['vol','Volume'],['act','Activity']].map(([k,l])=>`<button class="pill" style="min-height:28px;padding:0 10px;font-size:12px" data-sort="${k}" aria-pressed="${f.sort===k}">${l}</button>`).join('')}</div>`;
  const live=S.real?.length?`${all.filter(t=>t.real).length} real tokens shown · ${all.filter(t=>t.real&&t.verified).length} confirmed on-chain. Real tokens are read-only.`:'';
  $('#cols').innerHTML=colsData.map(([t,d,list,empty])=>`<section class="panel flush col" aria-label="${t}"><div class="ph" style="flex-wrap:wrap"><div><h2>${t}</h2><p class="muted" style="font-size:12.5px;margin-top:2px">${d}</p></div></div><div class="cl">${list.length?list.map(card).join(''):`<div class="empty"><b>Nothing to show</b>${empty}</div>`}</div></section>`).join('')
  +`<section class="panel flush" style="grid-column:1/-1" aria-label="Markets"><div class="ph" style="flex-wrap:wrap"><div><h2>Markets</h2><p class="muted" style="font-size:12.5px;margin-top:2px">Tokens trading on a DEX pool, not on a launchpad curve. ${live}</p></div>${sorts}</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;padding:12px">${mk.length?mk.map(card).join(''):'<div class="empty"><b>No markets match these filters</b>Clear a filter or pick another chain.</div>'}</div></section>`;
},
strip(){const el=$('#nsol');if(!el)return;const f=S.f;if(!S.realInfo?.enabled||!(f.chain==='all'||f.chain==='solana')){el.innerHTML='';return}
  const items=(S.liveItems||[]).slice(0,8),ls=S.ls||{},ok=ls.state==='open',age=ms=>V.sniper.age(ms),risk={'no-flags':'<span class="chip ok">No flags</span>',warn:'<span class="chip warn">Caution</span>',quarantined:'<span class="chip warn" title="Token-2022 mints are not understood by this engine">Unusual</span>',blocked:'<span class="chip bad">Blocked</span>',unchecked:'<span class="chip">Not checked</span>'};
  const row=it=>{const pump=it.pad==='pump-fun',url=pump?`https://pump.fun/coin/${it.contract}`:`https://dexscreener.com/solana/${it.pool}`;return `<tr><td class="num">${age(Date.now()-(it.seenAt||Date.now()))}</td><td><b>${esc(it.sym)}</b> <span class="faint">${esc(it.name)}</span></td><td>${pump?'Pump.fun':'Raydium'}</td><td>${risk[it.verdict]||''}</td><td><a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(it.contract)}">${esc(short(it.contract))}</a></td></tr>`};
  el.innerHTML=`<div class="panel stack" style="margin:12px 0"><div class="row sb"><h2 style="margin:0">New on Solana</h2><span>${ok?'<span class="chip ok">Live</span>':`<span class="chip warn">${ls.state==='stopped'?'Off':'Connecting'}</span>`} <button class="btn sm" data-allnew="1">See all new tokens</button></span></div>${items.length?`<div class="tw"><table><thead><tr><th>Age</th><th>Token</th><th>Where</th><th>Risk check</th><th>Address</th></tr></thead><tbody>${items.map(row).join('')}</tbody></table></div>`:`<p class="muted" style="margin:0">${ok?'Waiting for the next launch. New tokens appear as soon as they are confirmed.':esc(ls.lastError||'Connecting to the Solana launch stream…')}</p>`}<p class="faint" style="margin:0;font-size:12px">Every Pump.fun creation and Raydium pool creation, read from the chain (confirmed, not finalized). Pump.fun tokens are for watching only: this engine cannot trade their bonding curve yet.</p></div>`},
tick(){this.strip();const now=Date.now();if(now-(this.j||0)>6000){this.j=now;if(!S.frozen)S.sample.forEach(t=>{const k=1+(Math.random()-.5)*.012;t.price*=k;t.chg=+(t.chg+(Math.random()-.5)*.6).toFixed(1);t.liq*=1+(Math.random()-.5)*.012;t.vol*=1+Math.random()*.004;t.act=Math.round(t.act*(1+(Math.random()-.5)*.08))})}this.draw()}};

/* ---------- Trade ---------- */
const TOK_OPT=()=>allTokens().map(t=>`<option value="${t.id}" ${t.id===S.token?'selected':''}>${esc(t.sym)} · ${esc(t.name)}${t.live?'':t.real?' (real, read-only)':' (sample)'}</option>`).join('');
const balOf=(w,t)=>{const wl=S.ov.wallets.find(x=>x.id===w);if(!wl)return 0n;if(t==='SIM'||t==='native')return BigInt(wl.native);return BigInt(wl.tokens.find(x=>x.token===t)?.bal||0)};
function chartSvg(t){
  const W=720,H=250,pad=44;let pts,sub;
  if(t.live){const h=S.hist[t.id]||[];pts=h.map(x=>x.p);sub=isLive()?`Forked WETH/USDC pool price in ETH per USDC, ${h.length} point${h.length===1?'':'s'} since you opened the terminal. It moves when trades or new blocks change the pool.`:`Practice pool price, ${h.length} point${h.length===1?'':'s'} since you opened the terminal. It moves only when trades happen.`}
  else{pts=seeded(t.id,60,t.chg||0).map(x=>x*t.price);sub='Illustrative price path for a sample token. Not real market data.'}
  if(pts.length<2)pts=[pts[0]??t.price,pts[0]??t.price];
  const mn=Math.min(...pts),mx=Math.max(...pts),rg=(mx-mn)||mx*.02||1,lo=mn-rg*.1,hi=mx+rg*.1;
  const X=i=>pad+i/(pts.length-1)*(W-pad-8),Y=v=>H-24-((v-lo)/(hi-lo))*(H-44);
  const line=pts.map((v,i)=>`${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const up=pts[pts.length-1]>=pts[0],col=up?'#2fcb73':'#e13b3b';
  const marks=t.live?(S.txs||[]).filter(x=>x.token===t.id&&['sent','confirmed','final'].includes(x.stage)).map(x=>{const h=S.hist[t.id]||[];let i=h.length-1;for(let k=0;k<h.length;k++)if(h[k].block>=(x.quoteBlock||0)){i=k;break}const px=X(Math.min(i,pts.length-1)),py=Y(pts[Math.min(i,pts.length-1)]);return x.side==='buy'?`<path d="M${px},${py-4}l6,-11h-12z" fill="#2fcb73"><title>Your buy</title></path>`:`<path d="M${px},${py+4}l6,11h-12z" fill="#e13b3b"><title>Your sell</title></path>`}).join(''):'';
  const grid=[0,.5,1].map(f=>{const v=lo+(hi-lo)*f;return `<line x1="${pad}" x2="${W-8}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${pad-6}" y="${Y(v)+4}" text-anchor="end" font-size="11" fill="var(--faint)">${isLive()?Number(v.toPrecision(4)):price(v)}</text>`}).join('');
  let vol='';if(!t.live){const r=seeded(t.id+'v',60,0);vol=r.map((v,i)=>`<rect x="${X(i)-3}" y="${H-24-Math.abs(v-1)*160}" width="5" height="${Math.abs(v-1)*160}" fill="var(--line2)" opacity=".7"/>`).join('')}
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Price chart for ${esc(t.sym)}. ${up?'Rising':'Falling'} over the period shown.">${grid}${vol}<polyline fill="none" stroke="${col}" stroke-width="2.2" stroke-linejoin="round" points="${line}"/>${marks}</svg><p class="faint" style="font-size:12px;margin-top:4px">${sub}${t.live?' Triangles mark your executions.':' Volume bars are illustrative.'}</p>`;
}
V.trade={title:'Trade',needsData:true,tab:'activity',btab:'holdings',
html(){const t=tokById(S.token)||allTokens()[0];S.token=t.id;
  return practiceNote()+`<div class="panel" style="margin-bottom:14px"><div class="row sb"><div class="row" style="gap:12px">${avatar(t.sym,t.color,44)}<div><div class="row" style="gap:8px"><h1 style="font-size:22px">${esc(t.sym)}</h1><span class="muted">${esc(t.name)}</span>${chainChip(t.chain)}${t.live?'':sampleTag}</div>
  <div class="row" style="gap:8px;margin-top:3px">${t.live?`<button class="btn ghost sm mono" id="cc" data-copy="${esc(t.contract)}" style="min-height:24px;padding:0 6px">${short(t.contract)} ⧉</button>`:'<span class="faint">No contract (sample)</span>'}<span class="num" style="font-size:18px;font-weight:700">${pxs(t)}</span>${isLive()?'<span class="faint">per USDC</span>':''}${t.chg!=null?`<span class="${t.chg>=0?'up':'dn'}">${t.chg>=0?'▲':'▼'} ${Math.abs(t.chg).toFixed(1)}% 24h</span>`:''}</div></div></div>
  <div class="row"><button class="btn sm star" id="star" aria-pressed="${S.watch.has(t.id)}">${S.watch.has(t.id)?'★ Watching':'☆ Watch'}</button><div style="min-width:200px"><label class="sr" for="tsel">Token</label><select id="tsel">${TOK_OPT()}</select></div></div></div></div>
  <div class="tradegrid"><div class="stack">
   <div class="panel flush"><div class="chartwrap">${chartSvg(t)}</div></div>
   <div class="panel flush"><div class="tabs" role="tablist" aria-label="Analysis">${[['activity','Activity'],['holders','Holders'],['liquidity','Liquidity'],['controls','Contract controls']].map(([k,l])=>`<button role="tab" data-tab="${k}" aria-selected="${this.tab===k}">${l}</button>`).join('')}</div><div class="pb" id="an"></div></div>
   <div class="panel flush"><div class="tabs" role="tablist" aria-label="Your activity">${[['holdings','Holdings'],['pending','Pending transactions'],['orders','Orders'],['strategy','Strategy activity']].map(([k,l])=>`<button role="tab" data-bt="${k}" aria-selected="${this.btab===k}">${l}</button>`).join('')}</div><div class="pb tw" id="bp"></div></div></div>
   <aside class="panel ticket stack" aria-label="Trade ticket" id="tk"></aside></div>`},
async mount(){
  const t=tokById(S.token);
  $('#tsel').onchange=e=>{S.token=e.target.value;S.amt='';render()};
  $('#star').onclick=()=>{S.watch.has(t.id)?S.watch.delete(t.id):S.watch.add(t.id);store.set('watch',[...S.watch]);render()};
  const cc=$('#cc');if(cc)cc.onclick=async()=>{try{await navigator.clipboard.writeText(cc.dataset.copy);toast('success','Contract copied','The full practice contract address is on your clipboard.')}catch{toast('warn','Could not copy','Copy the address manually.')}};
  $$('[data-tab]').forEach(b=>b.onclick=()=>{this.tab=b.dataset.tab;$$('[data-tab]').forEach(x=>x.setAttribute('aria-selected',x===b));this.drawAn()});
  $$('[data-bt]').forEach(b=>b.onclick=()=>{this.btab=b.dataset.bt;$$('[data-bt]').forEach(x=>x.setAttribute('aria-selected',x===b));this.drawBp()});
  this.ticket();await this.load();this.drawAn();this.drawBp();
},
async load(){try{const [txs,ord,cp]=await Promise.all([api('/api/txs'),api('/api/orders'),isLive()?null:api('/api/copy')]);S.txs=txs;this.orders=ord;this.copy=cp;this.err=false}catch{this.err=true}this.loaded=true},
async tick(){await this.load();this.drawAn();this.drawBp();this.drawLast&&this.drawLast();
  const t=tokById(S.token);if(t?.live&&$('.chartwrap')){$('.chartwrap').innerHTML=chartSvg(t)}},
drawReal(t,el){
  el.onclick=async e=>{const b=e.target.closest('[data-copy]');if(!b)return;try{await navigator.clipboard.writeText(b.dataset.copy);toast('success','Address copied','The full address is on your clipboard.')}catch{toast('warn','Could not copy','Select the address and copy it manually.')}};
  S.tinfo=S.tinfo||{};const rec=S.tinfo[t.id],usd=n=>'$'+Number(n||0).toLocaleString('en',{maximumFractionDigits:0}),pc=n=>n==null?'not read':n+'%',cp=a=>`<button class="btn ghost sm mono" data-copy="${esc(a)}" title="Copy full address" style="min-height:22px;padding:0 6px">${short(a)} ⧉</button>`;
  if(this.tab==='liquidity')return el.innerHTML=`<div class="kv"><span>Venue</span><b>${esc(t.venue)}</b></div><div class="kv"><span>Pool address</span>${cp(t.pool)}</div><div class="kv"><span>Liquidity</span><b class="num">${usd(t.liq)}</b></div><div class="kv"><span>Volume 24h</span><b class="num">${usd(t.vol)}</b></div><div class="kv"><span>Market cap</span><b class="num">${t.mcap!=null?usd(t.mcap):'n/a'}</b></div><div class="kv"><span>FDV</span><b class="num">${t.fdv!=null?usd(t.fdv):'n/a'}</b></div>${notice('plain','Where this comes from',esc(t.source)+'. Pool existence is checked on-chain by this app; the numbers are not.')}`;
  if(!rec){S.tinfo[t.id]={loading:true};api('/api/tokeninfo?contract='+encodeURIComponent(t.contract)).then(r=>{S.tinfo[t.id]=r}).catch(()=>{S.tinfo[t.id]={ok:false,title:'Could not load token details',why:'The terminal did not answer.',fix:'Try again in a moment.'}}).then(()=>{if(S.token===t.id&&$('#an'))this.drawAn()});return el.innerHTML=skeleton(3)}
  if(rec.loading)return el.innerHTML=skeleton(3);
  if(rec.ok===false)return el.innerHTML=notice('error',esc(rec.title),`${esc(rec.why)} ${esc(rec.fix||'')}`);
  const notes=`<details style="margin-top:10px"><summary class="faint">What was not read (${rec.notes.length})</summary><ul style="margin:6px 0 0 18px">${rec.notes.map(n=>`<li class="faint" style="font-size:12.5px">${esc(n)}</li>`).join('')}</ul></details>`;
  if(this.tab==='controls'){const d=rec.dev,chip=(ok,y,n,u)=>`<span class="chip ${ok==null?'':ok?'ok':'warn'}">${ok==null?u:ok?y:n}</span>`;
    return el.innerHTML=`<div class="kv"><span>Creator (dev)</span>${d.creator?cp(d.creator):'<span class="faint">not read for this token</span>'}</div><div class="kv"><span>Creator holds</span><b class="num">${pc(d.creatorHoldPct)}</b></div><div class="kv"><span>Owner</span>${d.owner?cp(d.owner):'<span class="faint">'+(d.renounced?'none (renounced)':'not shown')+'</span>'}</div><div class="kv"><span>More supply can be minted</span>${chip(d.mintable==null?null:!d.mintable,'No','Yes','Not read')}</div><div class="kv"><span>Holder accounts can be frozen</span>${chip(d.freezeAuthority==null&&rec.chain==='solana'?true:d.freezeAuthority?false:null,'No','Yes','Not read')}</div>${d.mintAuthority?`<div class="kv"><span>Mint authority</span>${cp(d.mintAuthority)}</div>`:''}${d.freezeAuthority?`<div class="kv"><span>Freeze authority</span>${cp(d.freezeAuthority)}</div>`:''}${notes}`}
  if(this.tab==='holders'){const h=rec.holders;if(!h)return el.innerHTML=notice('info','Top holders are not read for this token','Holder lists on Ethereum and BNB Smart Chain need an indexer. On Solana they come straight from the chain.')+notes;
    return el.innerHTML=`<div class="kv"><span>Top 10 hold</span><b class="num">${h.top10Pct}%</b></div>${h.top10ExCurvePct!=null?`<div class="kv"><span>Top 10 of the supply not on the curve</span><b class="num">${h.top10ExCurvePct}%</b></div>`:''}<div class="tw" style="margin-top:10px"><table><thead><tr><th>#</th><th>Owner</th><th class="r">Share</th><th></th></tr></thead><tbody>${h.top.map((x,i)=>`<tr><td>${i+1}</td><td>${x.owner?cp(x.owner):'<span class="faint">unknown</span>'}</td><td class="r num">${x.pct}%</td><td>${x.label?`<span class="chip">${esc(x.label)}</span>`:''}</td></tr>`).join('')}</tbody></table></div>${notes}`}
  const tr=rec.trades;if(!tr)return el.innerHTML=notice('info','No trade feed for this token',esc(rec.notes.find(n=>/trade feed|rate limited|DEX pool/i.test(n))||'Trades are not available.'))+notes;
  el.innerHTML=`<div class="kv"><span>Recent buys / sells</span><b class="num">${tr.buys} (${usd(tr.buyUsd)}) / ${tr.sells} (${usd(tr.sellUsd)})</b></div><div class="kv"><span>Unique buyers / sellers</span><b class="num">${tr.uniqueBuyers} / ${tr.uniqueSellers}</b></div>
  <h3 style="margin:12px 0 4px">Largest trades</h3><div class="tw"><table><tbody>${tr.largest.map(x=>`<tr><td class="${x.side==='buy'?'up':'dn'}">${x.side}</td><td>${cp(x.wallet)}</td><td class="r num">${usd(x.usd)}</td><td>${x.usd>=tr.whaleUsd?'<span class="chip warn">Whale</span>':''}</td></tr>`).join('')}</tbody></table></div>
  <h3 style="margin:12px 0 4px">Top buyers</h3><div class="tw"><table><tbody>${tr.topBuyers.map(x=>`<tr><td>${cp(x.wallet)}</td><td class="r num">${usd(x.usd)}</td><td class="r faint">${x.n} buy${x.n===1?'':'s'}</td></tr>`).join('')}</tbody></table></div>
  <h3 style="margin:12px 0 4px">Latest trades</h3><div class="tw"><table><thead><tr><th>Time</th><th>Side</th><th>Wallet</th><th class="r">Size</th></tr></thead><tbody>${tr.items.slice(0,20).map(x=>`<tr><td class="faint">${esc(String(x.t).slice(11,19))} UTC</td><td class="${x.side==='buy'?'up':'dn'}">${x.side}</td><td>${cp(x.wallet)}</td><td class="r num">${usd(x.usd)}${x.usd>=tr.whaleUsd?' <span class="chip warn">Whale</span>':''}</td></tr>`).join('')}</tbody></table></div>${notice('plain','Source',esc(tr.source)+`. Whale = ${usd(tr.whaleUsd)} or more.`)}${notes}`;
},
drawAn(){const el=$('#an');if(!el)return;const t=tokById(S.token);
  if(t.real)return this.drawReal(t,el);
  if(!t.live&&this.tab!=='activity')return el.innerHTML=notice('plain','Not available for sample tokens','Holder lists, liquidity detail and contract checks need a real token. Pick a Practice network token to see them.');
  if(this.tab==='activity'){const l=(S.txs||[]).filter(x=>x.token===t.id);el.innerHTML=!t.live?`<div class="empty"><b>No trades for a sample token</b>Sample tokens are display-only.</div>`:this.err?notice('error','Could not load activity','Retrying automatically.'):l.length?`<div class="tw"><table><thead><tr><th>Trade</th><th>Wallet</th><th>Source</th><th>Status</th></tr></thead><tbody>${l.map(x=>`<tr><td>${esc(x.headline)}</td><td>${esc(walletName(x.wallet))}</td><td>${esc(x.origin)}</td><td>${stageChip(x.stage)}</td></tr>`).join('')}</tbody></table></div>`:`<div class="empty"><b>No trades for ${esc(t.sym)} yet</b>Your trades, and those from your rules, will be listed here.</div>`}
  if(this.tab==='holders')el.innerHTML=`${notice('info','No public holder list',`Holder distribution needs a live chain indexer. ${isLive()?'The local fork has none':'The practice network does not have one'}. Your own wallets are shown below.`)}<div class="tw" style="margin-top:10px"><table><thead><tr><th>Wallet</th><th class="r">${esc(t.sym)} held</th></tr></thead><tbody>${S.ov.wallets.map(w=>`<tr><td>${esc(w.name)}</td><td class="r num">${secret(fa(balOf(w.id,t.id),t.id,{bare:true}))}</td></tr>`).join('')}</tbody></table></div>`;
  if(this.tab==='liquidity')el.innerHTML=`<div class="kv"><span>Pool size (${QSYM()} side)</span><b class="num">${isLive()?fa(t.liq,'native',{frac:1}):fmt(t.liq)+' SIM'}</b></div><div class="kv"><span>Price</span><b class="num">${price(t.price)} ${QSYM()}${isLive()?' per USDC':''}</b></div><div class="kv"><span>Pool type</span><span>${isLive()?'Uniswap V2 constant-product pool (forked)':'Constant-product pool (practice)'}</span></div><div class="kv"><span>Liquidity lock</span><span>Not verifiable here</span></div><p class="hint faint" style="margin-top:8px">Larger trades move the price more in a small pool. The ticket shows the price impact before you confirm.</p>`;
  if(this.tab==='controls'&&isLive()){el.innerHTML=notice('info','Token safety checks are not available on the local fork yet','Contract controls and test buys need the safety checker, which only runs in the practice simulator. USDC here is the real forked contract; nothing is checked or implied.');return}
  if(this.tab==='controls'){const c=S.risk[t.id];if(!c){el.innerHTML=skeleton(2);fetchRisk(t.id).then(()=>this.drawAn());return}el.innerHTML=`<div class="row sb"><h3>Test results</h3><span class="faint">Tested ${clk(c.at)} at block ${c.r.block} <button class="btn sm" id="rr">Test again</button></span></div><div class="finds" style="margin-top:10px">${findingsFor(t).map(f=>`<div class="find ${f.lvl}"><span>${FIC[f.lvl]}</span><div>${esc(f.text)}</div></div>`).join('')}</div><p class="hint faint" style="margin-top:10px">${esc(c.r.disclaimer||'A passing test lowers risk but cannot prove a token is safe.')}</p>`;$('#rr').onclick=async()=>{await fetchRisk(t.id,true);this.drawAn()}}},
drawBp(){const el=$('#bp');if(!el)return;if(this.err)return el.innerHTML=notice('error','Could not load your activity','Retrying automatically. Nothing was changed.');if(!this.loaded)return el.innerHTML=skeleton(2);
  if(this.btab==='holdings'){const rows=[];S.ov.wallets.forEach(w=>{rows.push([w.name,QSYM(),w.native,'native']);w.tokens.forEach(k=>rows.push([w.name,k.sym,k.bal,k.token]))});el.innerHTML=`<table><thead><tr><th>Wallet</th><th>Asset</th><th>Chain</th><th class="r">Balance</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${chainChip('practice')}</td><td class="r num">${secret(fa(r[2],r[3],{bare:true}))}</td></tr>`).join('')}</tbody></table>`}
  if(this.btab==='pending'){const l=(S.txs||[]).filter(x=>!['final','failed','expired'].includes(x.stage));el.innerHTML=l.length?l.map(x=>txCard(x)).join(''):`<div class="empty"><b>Nothing pending</b>Submitted trades show here until they are final.</div>`}
  if(this.btab==='orders'){const l=this.orders||[];el.innerHTML=l.length?`<table><thead><tr><th>Rule</th><th>Token</th><th>State</th></tr></thead><tbody>${l.map(o=>`<tr><td>${esc(o.label)}</td><td>${esc(o.token)}</td><td>${orderChip(o)} <span class="muted">${esc(o.statusText)}</span></td></tr>`).join('')}</tbody></table>`:`<div class="empty"><b>No orders</b>Set a stop loss or take profit in the ticket, or create a rule on the Orders page.<br><button class="btn" id="go-o">Go to Orders</button></div>`;const g=$('#go-o');if(g)g.onclick=()=>go('orders')}
  if(this.btab==='strategy'){const c=this.copy;el.innerHTML=c&&c.log.length?c.log.map(l=>notice(l.decision==='emit'?'ok':'plain','',esc(l.text))).join('<div style="height:6px"></div>'):`<div class="empty"><b>No strategy activity yet</b>${isLive()?'Orders report their decisions here. Copy trading and the sniper are not available on the local fork.':'Copy trading, orders and the sniper report their decisions here, including why they skipped a trade.'}</div>`}},
ticket(){
  const t=tokById(S.token),el=$('#tk');
  if(!t.live){el.innerHTML=`<h2>Trade ticket</h2>${ctxStrip({token:t.sym,chain:CHAINS[t.chain].name,wallet:'None',limit:'None',status:t.real?'Read-only':'Sample only'})}${(t.real?notice('warn','Read-only market data','This is a real token on '+esc(CHAINS[t.chain].name)+'. This app only reads real markets: it cannot quote or trade it. Choose a Practice network token such as MEME to place a trade.'):notice('warn','Sample token','Practice mode cannot quote or trade this token. Choose a Practice network token such as MEME to place a trade.'))}<button class="btn primary" disabled>Review buy</button>`;return}
  const oc=S.oneClick&&S.oneClick.live===isLive()?S.oneClick:null,sell=S.side==='sell';
  el.innerHTML=`<div class="seg ${sell?'sellmode':''}" id="sd" role="group" aria-label="Side"><button data-s="buy" aria-pressed="${!sell}">Buy</button><button data-s="sell" aria-pressed="${sell}">Sell</button></div>
  <div><label for="wsel">Wallet</label><select id="wsel">${S.ov.wallets.map(w=>`<option value="${w.id}" ${w.id===S.wallet?'selected':''}>${esc(w.name)} · ${NET()}</option>`).join('')}</select><div class="row sb" style="margin-top:5px;font-size:12.5px"><span class="muted">Available</span><b class="num" id="bal"></b></div></div>
  <div><label for="amt">${sell?`Sell ${esc(t.sym)}`:`Spend ${QSYM()}`}</label><div class="amtbox"><input id="amt" inputmode="${isLive()?'decimal':'numeric'}" autocomplete="off" placeholder="0" value="${esc(S.amt)}"><span>${sell?esc(t.sym):QSYM()}</span></div>
  <div class="quick" id="qa" style="margin-top:8px">${(sell?[25,50,75,100]:quick().buy).map(v=>`<button data-v="${v}" aria-pressed="false">${sell?v+'%':isLive()?v:compact(v)}</button>`).join('')}</div></div>
  <div class="row sb"><label for="slp" style="margin:0">Slippage limit</label><select id="slp" style="width:90px">${[[100,'1%'],[300,'3%'],[500,'5%'],[1000,'10%']].map(([v,l])=>`<option value="${v}" ${S.slip===v?'selected':''}>${l}</option>`).join('')}</select></div>
  <div id="pv" aria-live="polite"></div>
  ${ctxStrip({token:t.sym,chain:NET(),wallet:walletName(S.wallet),limit:S.amt?`${S.amt} ${sell?t.sym:QSYM()}`:'Not set',status:'Not sent'})}
  <button class="btn ${sell?'sell':'buy'}" id="go" style="width:100%;min-height:46px" disabled>${sell?'Review sell':'Review buy'}</button><div class="hint faint" id="why" style="font-size:12.5px"></div>
  <div class="row sb" style="border-top:1px solid var(--line);padding-top:10px"><span class="muted">One-click trading: <b>${oc?`On (max ${oc.max} ${QSYM()}, ${oc.slip/100}% slippage)`:'Off'}</b></span><button class="btn sm" id="oc">${oc?'Turn off':'Set up'}</button></div>
  <div style="border-top:1px solid var(--line);padding-top:12px" class="stack"><h3>Automation</h3><div class="row" style="flex-wrap:nowrap"><div style="flex:1"><label for="sl">Stop loss (${QSYM()}${isLive()?' per USDC':''})</label><input id="sl" inputmode="decimal" placeholder="Not set"></div><div style="flex:1"><label for="tp">Take profit (${QSYM()}${isLive()?' per USDC':''})</label><input id="tp" inputmode="decimal" placeholder="Not set"></div></div><div id="xe"></div><button class="btn" id="ex" style="width:100%">Set exit rules</button></div>`;
  this.wire();
},
wire(){
  const t=tokById(S.token),sell=S.side==='sell';const uid=sell?t.id:'native',bal=()=>balOf(S.wallet,uid);
  const upBal=()=>{$('#bal').innerHTML=secret(fa(bal(),uid))};upBal();
  $('#sd').onclick=e=>{const b=e.target.closest('button');if(b){S.side=b.dataset.s;S.amt='';this.ticket()}};
  $('#wsel').onchange=e=>{S.wallet=e.target.value;upBal();prev()};
  $('#slp').onchange=e=>{S.slip=Number(e.target.value);prev()};
  $('#amt').oninput=e=>{S.amt=e.target.value.replace(isLive()?/[^\d.]/g:/[^\d]/g,'');if(isLive()){const p=S.amt.split('.');if(p.length>2)S.amt=p[0]+'.'+p.slice(1).join('')}e.target.value=S.amt;$$('#qa button').forEach(b=>b.setAttribute('aria-pressed','false'));prev()};
  $('#qa').onclick=e=>{const b=e.target.closest('button');if(!b)return;const v=BigInt(sell?b.dataset.v:0);S.amt=sell?plainStr(bal()*v/100n,U(uid).dec):b.dataset.v;$('#amt').value=S.amt;$$('#qa button').forEach(x=>x.setAttribute('aria-pressed',x===b));prev()};
  $('#oc').onclick=()=>oc?(S.oneClick=null,store.set('oneClick',null),this.ticket()):oneClickSetup(()=>this.ticket());
  $('#ex').onclick=()=>exitRules(t);
  let timer;const self=this;
  async function prev(){clearTimeout(timer);{const cb=document.querySelectorAll('#tk .ctx b')[3];if(cb)cb.textContent=S.amt?`${S.amt} ${sell?t.sym:QSYM()}`:'Not set'}timer=setTimeout(async()=>{const a=S.amt,go=$('#go'),why=$('#why'),pv=$('#pv');if(!go)return;
    const raw=a?toRaw(a,uid):null;if(!a||raw==null||raw===0n){pv.innerHTML='';go.disabled=true;go.textContent=sell?'Review sell':'Review buy';why.textContent='Enter an amount to see what you would receive.';return}
    let q;try{q=await api('/api/quote',{token:t.id,side:S.side,amount:String(raw),slippageBps:S.slip,walletId:S.wallet})}catch{pv.innerHTML=notice('error','Cannot get a quote','The practice network is not answering. Nothing was sent.');go.disabled=true;return}
    if(!q.ok){pv.innerHTML=notice('error',esc(q.title),esc(q.why));go.disabled=true;return}
    const short_=raw>bal(),outId=sell?'native':t.id,fee=q.fees;
    pv.innerHTML=`<div class="kv"><span>You get about</span><b class="num">${fa(q.expectedOut,outId)}</b></div><div class="kv"><span>Minimum received</span><b class="num">${fa(q.minOut,outId)}</b></div><div class="kv"><span>Price impact</span><span class="num ${q.impactBps>300?'dn':''}">${(q.impactBps/100).toFixed(2)}%</span></div>
    ${feeRows(q,uid)}
    <details class="route"><summary>Route</summary><div>${esc(S.ov.tokens.find(x=>x.address===t.id).sym)} via ${esc(q.venue)} (${isLive()?'forked mainnet pool':'practice pool'}), quoted at block ${q.block}. Single hop, no bridge.</div></details>${q.warnings.filter(w=>w.level!=='info'&&!/holds .* but you entered/.test(w.text)).map(w=>notice(w.level==='error'?'error':'warn','',esc(w.text))).join('')}`;
    const blocked=q.warnings.some(w=>w.level==='error'&&!/holds .* but you entered/.test(w.text));
    self.q=q;self.short=short_;
    if(short_&&!sell){go.disabled=false;go.textContent='Add funds';go.className='btn';go.onclick=()=>go2('wallets',{flow:'fund'});why.textContent='This wallet does not hold enough SIM for that amount.'}
    else if(short_){go.disabled=true;go.textContent=`Not enough ${t.sym}`;why.textContent='Lower the amount or choose another wallet.'}
    else{go.className='btn '+(sell?'sell':'buy');const one=!sell&&oc&&oc.wallet===S.wallet&&raw<=toRaw(oc.max,'native')&&S.slip<=oc.slip;
      go.textContent=one?'Buy now (one-click)':sell?'Review sell':'Review buy';go.disabled=blocked;why.textContent=blocked?'Fix the issue above to continue.':one?'One-click is on: this sends immediately, within your limits.':'';
      go.onclick=()=>one?submit(false):review()}},220)}
  const go2=(v,o)=>go(v,o);
  const review=()=>{const q=this.q;modal({title:`Review ${sell?'sell':'buy'}`,body:`<div class="stack">${ctxStrip({token:t.sym,chain:NET(),wallet:walletName(S.wallet),limit:`${S.amt} ${sell?t.sym:QSYM()}`,status:'Not sent yet'})}
  <div class="kv"><span>You ${sell?'sell':'pay'}</span><b class="num">${S.amt} ${sell?t.sym:QSYM()}</b></div><div class="kv"><span>You get about</span><b class="num">${fa(q.expectedOut,sell?'native':t.id)}</b></div><div class="kv"><span>Minimum received</span><b class="num">${fa(q.minOut,sell?'native':t.id)}</b></div><div class="kv"><span>Price impact</span><span class="num">${(q.impactBps/100).toFixed(2)}%</span></div><div class="kv"><span>Slippage limit</span><span>${S.slip/100}%</span></div>
  ${feeRows(q,uid)}${notice('plain','','If the price moves past your slippage limit the trade is stopped and you only pay the network fee. Slippage is never raised for you.')}</div>`,
  actions:[{label:'Back',cls:'ghost'},{label:sell?'Confirm sell':'Confirm buy',cls:sell?'sell':'buy',fn:()=>submit(true)}]})};
  const submit=async()=>{const go=$('#go');if(go)go.disabled=true;S.cid=S.cid||Math.random().toString(36).slice(2);const x=await act('/api/trade',{token:t.id,side:S.side,amount:String(toRaw(S.amt,uid)),slippageBps:S.slip,walletId:S.wallet,clientId:S.cid});if(x&&x.key){S.lastTx=x.key;S.cid=null;S.amt='';this.ticket();this.tick()}else if(go)go.disabled=false};
  this.drawLast=async()=>{if(!S.lastTx||!$('#tk'))return;const x=(S.txs||[]).find(y=>y.key===S.lastTx);let box=$('#lastbox');if(!box){box=document.createElement('div');box.id='lastbox';$('#tk').prepend(box)}box.innerHTML=x?`<h3 style="margin-bottom:6px">Latest trade</h3>${txCard(x)}`:''};
  prev();this.drawLast();
}};
/** Itemised fees. Simulator: integers in SIM. Real node: pool fee in the sold asset, network fee in ETH, no platform fee. */
function feeRows(q,uid){const live=isLive();return `<div class="kv"><span>${live?'Platform fee':'Platform fee (1%)'}</span><span class="num">${live?'None on the fork':fmt(q.fees.platform)}</span></div><div class="kv"><span>Pool fee</span><span class="num">${live?fa(q.fees.pool,uid):fmt(q.fees.pool)}</span></div><div class="kv"><span>Network fee${live?' (estimate)':''}</span><span class="num">${live?fa(q.fees.network,'native'):fmt(q.fees.network)}</span></div>`}
function oneClickSetup(done){
  modal({title:'Set up one-click trading',body:`<div class="stack"><p class="muted">One-click buys skip the review step. They only run inside the limits you set here.</p>
  <div><label for="oc-w">Wallet</label><select id="oc-w">${S.ov.wallets.map(w=>`<option value="${w.id}" ${w.id===S.wallet?'selected':''}>${esc(w.name)} · ${NET()}</option>`).join('')}</select></div>
  <div><label for="oc-m">Maximum spend per click (${QSYM()})</label><input id="oc-m" inputmode="${isLive()?'decimal':'numeric'}" value="${isLive()?'0.1':'5000'}"></div>
  <div><label for="oc-s">Maximum slippage</label><select id="oc-s">${[[100,'1%'],[300,'3%'],[500,'5%']].map(([v,l])=>`<option value="${v}" ${v===300?'selected':''}>${l}</option>`).join('')}</select></div>
  <label style="display:flex;gap:10px;align-items:flex-start;color:var(--ink)"><input type="checkbox" id="oc-c" style="width:auto;min-height:0;margin-top:3px">I understand one-click buys are sent immediately, up to these limits.</label></div>`,
  actions:[{label:'Cancel',cls:'ghost'},{label:'Turn on',cls:'primary',fn:()=>{const m=$('#oc-m').value.trim(),mr=toRaw(m,'native');if(!$('#oc-c').checked||!mr){toast('warn','Finish setup','Set a spend limit and tick the confirmation box.');return false}S.oneClick={wallet:$('#oc-w').value,max:m,slip:Number($('#oc-s').value),live:isLive()};store.set('oneClick',S.oneClick);done&&done()}}]});
}
async function exitRules(t){
  const sl=Number($('#sl').value),tp=Number($('#tp').value),xe=$('#xe');
  if(!sl||!tp){xe.innerHTML=notice('warn','Set both prices','Enter a stop loss below and a take profit above the current price.');invalid(!sl?$('#sl'):$('#tp'),xe);return}
  if(!(sl<t.price&&tp>t.price)){xe.innerHTML=notice('warn','Check the prices',`Stop loss must be below the current price (${price(t.price)}) and take profit above it.`);invalid(!(sl<t.price)?$('#sl'):$('#tp'),xe);return}
  const held=balOf(S.wallet,t.id);if(held<=0n){xe.innerHTML=notice('warn','Nothing to protect',`${walletName(S.wallet)} holds no ${t.sym}. Exit rules protect a position you own: buy first, or pick another wallet.`);return}
  xe.innerHTML='';const r=await act('/api/orders',{kind:'bracket',token:t.id,amount:String(held),tp:String(tp),sl:String(sl),walletId:S.wallet});
  if(r.ok){xe.innerHTML=notice('ok','Exit rules set',`If ${t.sym} reaches ${tp} ${QSYM()} it sells ${fa(held,t.id)}; if it falls to ${sl} ${QSYM()} it sells instead. Only one can run.`);V.trade.tick()}
}
const STAGE_CHIP={preparing:['info','Preparing'],sent:['warn','Sent, not confirmed'],confirmed:['ok','Confirmed'],final:['ok','Final'],failed:['bad','Failed'],expired:['bad','Expired'],checking:['warn','Checking']};
const stageChip=s=>{const [c,t]=STAGE_CHIP[s]||['','Unknown'];return `<span class="chip ${c}">${t}</span>`};
const ORDER_CHIP={active:['info','Watching'],fired:['warn','Triggered'],cancelled:['','Cancelled'],expired:['','Expired'],failed:['bad','Failed'],disabled:['warn','Disabled']};
const orderChip=o=>{const [c,t]=ORDER_CHIP[o.status]||['',o.status];return `<span class="chip ${c}">${t}</span>`};
function tracker(t){const names=['Prepared','Sent','Confirmed','Final'],order=['preparing','sent','confirmed','final'],bad=['failed','expired'].includes(t.stage);
  const idx=bad?(t.history.some(h=>['submitted','observed'].includes(h.state))?1:0):Math.max(0,order.indexOf(t.stage));
  return `<div class="tracker ${bad?'bad':''}" role="list" aria-label="Trade progress">${names.map((n,i)=>`<div role="listitem" class="${i<idx||(!bad&&t.stage==='final')?'done':''} ${i===idx&&t.stage!=='final'?'now':''}">${bad&&i===idx?(t.stage==='expired'?'Expired':'Failed'):n}</div>`).join('')}</div>`}
function txCard(t){const f=t.fill,ex=t.explain;return `<div class="txc"><div class="row sb"><b>${esc(t.headline)}</b>${stageChip(t.stage)}</div>${ctxStrip({token:t.sym,chain:NET(),wallet:walletName(t.wallet),limit:fa(t.amountIn,t.side==='buy'?'native':t.token),status:STAGE_CHIP[t.stage]?.[1]||t.stage})}${tracker(t)}
  <p class="faint" style="font-size:12.5px">${{preparing:'Checking the price and your limits.',sent:'Sent to the network. This is not a fill yet.',confirmed:'In a block. Waiting for enough blocks to be final.',final:'Final. It can no longer be undone.',checking:'Connection lost. Checking the result before anything is repeated.',failed:'',expired:''}[t.stage]||''}</p>
  ${f?`<div class="kv"><span>Paid</span><b class="num">${fa(f.spent,t.side==='buy'?'native':t.token)}</b></div><div class="kv"><span>Received</span><b class="num">${fa(f.received,t.side==='buy'?t.token:'native')}</b></div>`:''}
  ${ex?notice('error',esc(ex.title),`<div>${esc(ex.why)}</div><div><b style="display:inline">What to do:</b> ${esc(ex.fix)}</div>`):''}
  <details class="tech"><summary>Technical details</summary><pre>${esc(t.history.map(h=>h.state+(h.note?'  – '+h.note:'')).join('\n'))}${t.raw?'\n\n'+esc(t.raw):''}</pre></details></div>`}
