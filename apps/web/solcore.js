/* Helpers for the standalone Solana page (/solana). The same Solana views (views3.js, views4.js) run here as in the practice terminal; this file supplies the few shared
 * helpers they need, without the practice terminal's shell, sample data or polling. */
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short=a=>a&&a.length>14?a.slice(0,6)+'…'+a.slice(-4):a;
const store={get(k,d){try{const v=localStorage.getItem('mint.'+k);return v==null?d:JSON.parse(v)}catch{return d}},set(k,v){try{localStorage.setItem('mint.'+k,JSON.stringify(v))}catch{}}};
const S={online:true,theme:store.get('theme','dark')};
document.documentElement.dataset.theme=S.theme;
const V={};
function setOnline(v){if(S.online!==v){S.online=v;const p=$('#netpill');if(p){p.dataset.state=v?'ok':'bad';p.querySelector('span').textContent=v?'Terminal connected':'Terminal not answering'}}}
async function api(p,b){
  try{const r=await fetch(p,b!==undefined?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}:undefined);const j=await r.json();setOnline(true);return j}
  catch(e){setOnline(false);throw e}
}
async function act(p,b){try{const r=await api(p,b);if(r&&r.ok===false)toast('error',r.title,`${r.why} ${r.fix}`);return r}catch{toast('error','Could not reach the terminal','The request did not go through, so nothing changed. Check that the server is running, then try again.');return{ok:false}}}
function toast(level,title,body){const t=document.createElement('div');t.className='toast '+level;t.innerHTML=`<b>${esc(title)}</b><span>${esc(body)}</span>`;t.onclick=()=>t.remove();$('#toasts').append(t);setTimeout(()=>t.remove(),level==='error'?12000:7000)}
const IC={ok:'✓',success:'✓',warn:'!',error:'✕',info:'i',plain:'i'};
const notice=(lvl,title,body='')=>`<div class="notice ${lvl}" role="${lvl==='error'?'alert':'note'}"><span class="ic" aria-hidden="true">${IC[lvl]}</span><div>${title?`<b>${title}</b>`:''}${body}</div></div>`;
const head=()=>'';   // this page has its own header
