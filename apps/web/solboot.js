/* Mounts the Solana view as a page of its own. Main column: the token workspace. Side column: Privy sign-in, wallet and safety, holdings. Search lives in the header. */
(function(){
  const view=V.solana,root=$('#view');
  root.innerHTML=view.html();
  // move the search box into the header, and drop the panel it came in
  const input=$('#sq'),go=$('#sgo'),slot=$('#searchslot');
  const panel=input.closest('.panel');
  input.placeholder='Search a token or paste a mint address';input.removeAttribute('id');input.id='sq';input.setAttribute('aria-label','Search a token by name, symbol or mint address');
  go.textContent='Search';go.className='btn sm primary';
  slot.append(input,go);panel&&panel.remove();
  const label=$('label[for="sq"]');label&&label.remove();

  const grid=document.createElement('div');grid.className='solgrid';
  const M=document.createElement('div'),A=document.createElement('aside');M.className='solcol solM';A.className='solcol solA';A.setAttribute('aria-label','Wallet and holdings');
  const welcome=document.createElement('section');welcome.id='welcome';welcome.className='panel pad welcome';
  welcome.innerHTML=`<h1>Trade Solana tokens</h1><p class="muted">Search a token by name or symbol, or paste a mint address. You see the route and a quote first. Nothing is signed or sent until you confirm.</p><div class="row quick"><button class="btn sm" data-q="bonk">Bonk</button><button class="btn sm" data-q="wif">dogwifhat</button><button class="btn sm" data-q="DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263">Bonk by address</button></div>`;
  M.append(welcome);
  [...root.children].forEach(el=>{if(el.id==='sprivy'||el.id==='swal')A.append(el);else if(el.id==='sres'||el.id==='stok')M.append(el)});
  const hist=document.createElement('div');hist.id='shist';M.append(hist);   // transaction history sits at the bottom of the main column
  const hold=$('#shold');if(hold)M.prepend(hold);   // holdings sit at the top of the main column, above the welcome card or the token
  grid.append(M,A);root.append(grid);
  view.mount();
  const hideWelcome=()=>{const hasTok=$('#stok').innerHTML.trim()||$('#sres').innerHTML.trim();welcome.hidden=!!hasTok};
  new MutationObserver(hideWelcome).observe(M,{childList:true,subtree:true});
  welcome.onclick=e=>{const b=e.target.closest('[data-q]');if(!b)return;input.value=b.dataset.q;view.search(b.dataset.q)};
  $('#themebtn').onclick=()=>{S.theme=S.theme==='dark'?'light':'dark';store.set('theme',S.theme);document.documentElement.dataset.theme=S.theme};
  addEventListener('keydown',e=>{if(e.key==='/'&&!/INPUT|TEXTAREA|SELECT/.test((document.activeElement||{}).tagName||'')&&!e.metaKey&&!e.ctrlKey){e.preventDefault();input.focus()}});
  // a token link such as /solana#<mint> opens that token straight away
  const open=()=>{const m=decodeURIComponent(location.hash.replace(/^#\/?/,''));if(m&&m.length>=32){input.value=m;view.search(m)}};
  addEventListener('hashchange',open);open();
  // keep the wallet panel fresh (balance, spent today, kill switch) without touching a field the user is typing in
  setInterval(()=>{if(document.hidden)return;const a=document.activeElement;if(a&&/INPUT|TEXTAREA|SELECT/.test(a.tagName)&&$('#swal').contains(a))return;view.wallet()},30000);
})();
