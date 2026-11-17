/* Professional layout for the standalone Solana page. Overrides how the shared Solana view (views3.js) presents search results and the token, and drives the header
 * (wallet chip and kill switch). Everything that trades still goes through the same view code, routes and checks as before: this file only changes presentation. */
(function(){
  const view=V.solana,SOL='So11111111111111111111111111111111111111112';
  const solfmt=l=>l==null?'–':(Number(l)/1e9).toLocaleString('en',{maximumFractionDigits:4});
  const looksMint=q=>/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q);
  const copy=async(t,btn)=>{try{await navigator.clipboard.writeText(t);const o=btn.textContent;btn.textContent='Copied';setTimeout(()=>btn.textContent=o,1200)}catch{toast('warn','Could not copy','Select the address and copy it by hand.')}};
  const hits=new Map();   // mint -> the search hit (name, symbol) so the token header can show it

  /* ---------- header: wallet chip and kill switch ---------- */
  function paintChip(){
    const w=view.w,chip=$('#wchip'),kill=$('#killbtn');if(!chip||!kill)return;
    if(!w||!w.connected){chip.innerHTML='<span class="dot off"></span><span>No wallet connected</span>';kill.hidden=true;return}
    const L=w.limits||{};
    chip.innerHTML=`<span class="dot ${w.killed?'bad':'on'}"></span><span class="mono" title="${esc(w.address)}">${esc(short(w.address))}</span><span class="sep"></span><b class="num">${esc(solfmt(w.balanceLamports))} SOL</b><span class="sep"></span><span class="muted">Spent today ${esc(solfmt(w.spentTodayLamports))} / ${esc(solfmt(L.dailyCapLamports))}</span>`;
    kill.hidden=false;kill.dataset.on=w.killed?'1':'0';kill.textContent=w.killed?'Trading paused: resume':'Pause trading';kill.className='btn sm '+(w.killed?'primary':'');
  }
  const origWallet=view.wallet;
  view.wallet=async function(){
    const was=!!(this.w&&this.w.connected),before=this.w&&this.w.address;
    await origWallet.call(this);paintChip();this.history();
    const now=!!(this.w&&this.w.connected);
    // connecting or disconnecting (or switching wallet) must redraw what depends on it: the open token's trade box and the simulate field
    if((was!==now||before!==(this.w&&this.w.address))&&this.openMint){
      const box=$('#strade');if(box)this.trade(this.openMint,box);
      const sw=$('#sw');if(sw&&now&&!sw.value)sw.value=this.w.address||'';
    }
  };

  /* ---------- transaction history ---------- */
  view.history=async function(){
    const el=$('#shist');if(!el)return;if(!this.w||!this.w.connected){el.innerHTML='';return}
    const r=await api('/api/sol/history',{}).catch(()=>null);if(!$('#shist'))return;if(!r||r.ok===false){el.innerHTML='';return}
    const usdf=v=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(v);
    const when=t=>t?new Date(t).toLocaleString('en',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'–';
    const sym=m=>(hits.get(m)||{}).symbol||short(m);
    const rows=r.rows.map(x=>{
      const sol=x.solDelta==null?'':`<span class="${x.solDelta<0?'neg':'pos'}">${x.solDelta>0?'+':''}${x.solDelta.toLocaleString('en',{maximumFractionDigits:5})} SOL</span>`+(r.solUsd?`<small class="muted"> ${esc(usdf(x.solDelta*r.solUsd))}</small>`:'');
      const tok=x.tokens.map(k=>`<div><span class="${k.delta<0?'neg':'pos'}">${k.delta>0?'+':''}${k.delta.toLocaleString('en',{maximumFractionDigits:4})}</span> <span class="muted">${esc(sym(k.mint))}</span></div>`).join('');
      return `<tr><td class="muted nowrap">${esc(when(x.time))}</td><td><span class="kind k-${esc(x.kind.split(' ')[0].toLowerCase())}">${esc(x.kind)}</span></td><td class="r num">${sol}${tok}</td><td class="r"><a href="https://solscan.io/tx/${encodeURIComponent(x.signature)}" target="_blank" rel="noopener noreferrer" title="${esc(x.signature)}">${esc(x.signature.slice(0,6))}…</a></td></tr>`}).join('');
    el.innerHTML=`<section class="panel flush"><div class="phead"><h2>Transaction history</h2><span class="muted">Last ${r.rows.length} on this wallet · read from the chain</span></div>${rows?`<div class="tw"><table><thead><tr><th>Time</th><th>Type</th><th class="r">Change</th><th class="r">Transaction</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<div class="pad muted">No transactions yet.</div>'}</section>`;
  };
  addEventListener('DOMContentLoaded',()=>{});
  document.addEventListener('click',async e=>{
    const k=e.target.closest('#killbtn');if(!k||!view.w)return;
    const r=await act('/api/sol/kill',{on:!view.w.killed});if(r&&r.ok!==false){toast('success',view.w.killed?'Trading allowed':'Trading paused','');view.wallet()}
  });

  /* ---------- search ---------- */
  view.search=async function(q){
    const el=$('#sres'),tok=$('#stok');q=(q||'').trim();
    if(!q){el.innerHTML='';return}
    if(looksMint(q)){el.innerHTML='';return this.token(q)}   // a full address skips the list
    tok.innerHTML='';el.innerHTML=`<div class="panel pad"><div class="skel" style="height:18px;width:40%"></div></div>`;
    let r;try{r=await api('/api/sol/search',{q})}catch{el.innerHTML=notice('error','Could not reach the terminal','Nothing was changed. Check that the server is running.');return}
    if(r.ok===false){el.innerHTML=notice('error',esc(r.title||'Search failed'),esc(r.why||''));return}
    (r.hits||[]).forEach(h=>hits.set(h.mint,h));
    const rows=(r.hits||[]).map(h=>`<button class="hit" data-m="${esc(h.mint)}"><span class="hn"><b>${esc(h.symbol)}</b><span class="muted">${esc(h.name||'')}</span></span><span class="mono muted">${esc(short(h.mint))}</span><span class="num">$${Math.round(h.liquidityUsd||0).toLocaleString('en')}<small class="muted"> liquidity</small></span></button>`).join('');
    el.innerHTML=`<div class="panel flush"><div class="phead"><h2>Results</h2><span class="muted">Third-party data. Check the mint address before you trade.</span></div>${rows||'<div class="pad muted">No token found. Try the full mint address.</div>'}</div>`+(r.sourceProblems&&r.sourceProblems.length?`<div class="muted small">Some sources failed: ${esc(r.sourceProblems.join('; '))}</div>`:'');
    $$('.hit',el).forEach(b=>b.onclick=()=>{el.innerHTML='';this.token(b.dataset.m)});
  };

  /* ---------- token workspace ---------- */
  view.token=async function(mint){
    const el=$('#stok');$('#sres').innerHTML='';el.innerHTML='<div class="panel pad"><div class="skel" style="height:22px;width:32%;margin-bottom:12px"></div><div class="skel" style="height:14px;width:60%"></div></div>';
    let r;try{r=await api('/api/sol/token',{mint})}catch{el.innerHTML=notice('error','Could not reach the terminal','');return}
    if(r.ok===false){el.innerHTML=notice('error',esc(r.title||'Could not read the token'),esc(r.why||''));return}
    this.openMint=mint;
    const f=r.facts||{},h=hits.get(mint),name=h?h.symbol:short(mint),sub=h?(h.name||''):'';
    const chip=(ok,t)=>`<span class="tag ${ok?'good':'bad'}">${esc(t)}</span>`;
    const warn=(f.warnings||[]).map(w=>notice('warn','Warning',esc(w))).join('');
    const ven=(r.venues||[]).map(v=>`<tr><td class="mono">${esc(v.venue)}</td><td class="r num">${esc(v.amountOut)}</td><td class="r num">${esc(v.priceImpactPct)}%</td></tr>`).join('');
    el.innerHTML=`<section class="panel tokhead"><div class="th1"><div><h2 class="tsym">${esc(name)}</h2>${sub?`<div class="muted">${esc(sub)}</div>`:''}</div><div class="addr"><span class="mono" title="${esc(r.mint)}">${esc(r.mint)}</span><button class="btn sm" id="cpm">Copy</button><a class="btn sm" target="_blank" rel="noopener noreferrer" href="https://solscan.io/token/${encodeURIComponent(r.mint)}">Solscan</a></div></div>
      <div class="tags"><span class="tag">Decimals ${esc(f.decimals)}</span>${chip(!f.mintAuthority,f.mintAuthority?'Mint authority set':'Mint authority renounced')}${chip(!f.freezeAuthority,f.freezeAuthority?'Freeze authority set':'Freeze authority renounced')}${r.tradable?'<span class="tag good">Route found</span>':'<span class="tag bad">No route</span>'}</div>${warn}</section>`+
    (r.tradable?`<section class="panel pad ticket"><div id="strade"></div></section>
      <section class="panel flush"><div class="phead"><h2>Routes</h2><span class="muted">Quote for a 0.01 SOL buy</span></div><div class="tw"><table><thead><tr><th>Route</th><th class="r">Raw units out</th><th class="r">Price impact</th></tr></thead><tbody>${ven}</tbody></table></div></section>
      <details class="panel pad simbox"><summary>Simulate a buy without trading</summary><div class="stack"><div><label for="sw">Wallet to simulate as (public address only)</label><input id="sw" autocomplete="off" spellcheck="false" value="${esc((this.w&&this.w.address)||'')}" placeholder="a funded wallet address"></div><div class="row"><button class="btn" id="ssim">Simulate 0.01 SOL buy</button></div><div id="ssr"></div></div></details>`
      :`<section class="panel pad">${notice('plain','No route found','Neither pump.fun nor Jupiter can trade this token. '+esc((r.notes||[]).join(' ')))}</section>`);
    $('#cpm').onclick=e=>copy(r.mint,e.target);
    if(!h)api('/api/sol/search',{q:mint}).then(s=>{const x=(s&&s.hits||[]).find(z=>z.mint===mint),t=$('.tsym');if(!x||!t)return;hits.set(mint,x);t.textContent=x.symbol;if(x.name){const d=document.createElement('div');d.className='muted';d.textContent=x.name;t.after(d)}}).catch(()=>{});
    if($('#strade'))this.trade(mint,$('#strade'));
    const b=$('#ssim');if(b)b.onclick=async()=>{const w=($('#sw').value.trim()||(this.w&&this.w.address)||''),o=$('#ssr');if(!w){o.innerHTML=notice('warn','Enter a wallet address','Sign in with your wallet, or paste any public wallet address to simulate as.');return}o.innerHTML=notice('plain','Simulating…','');let s;try{s=await api('/api/sol/simulate',{mint,wallet:w})}catch{o.innerHTML=notice('error','Could not reach the terminal','');return}
      o.innerHTML=s.ok===false?notice('error',esc(s.title||'Simulation failed'),esc(s.why||'')):notice(s.status==='success'?'ok':'warn','Simulation: '+esc(s.status),esc(s.reason||'The buy would succeed with this wallet.')+' '+esc(s.notice))};
    history.replaceState(null,'','#'+mint);
  };
})();
