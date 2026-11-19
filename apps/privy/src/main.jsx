/* Privy login for the terminal's Solana page. Privy's browser SDK is React-only, so this tiny React app is bundled separately and mounted into one box on the page.
 * After login, Privy's Solana wallets are handed to the page wrapped as Wallet Standard wallets, so the page treats them exactly like Phantom or Solflare. Signing goes through Privy's own
 * signMessage / signTransaction hooks with wallet dialogs turned on, so the user sees and approves what is signed. This file never sees or sends a trade: it logs in, lists wallets and signs on request. */
import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';
import { PrivyProvider, usePrivy, useLogin, useSigners, useWallets as useEvmWallets, useCreateWallet as useCreateEvmWallet, useSignMessage as useEvmSignMessage, useSendTransaction as useEvmSendTransaction, useIdentityToken, getAccessToken as getCustomerAccessToken, getIdentityToken } from '@privy-io/react-auth';
import { base } from 'viem/chains';
import { useWallets, useCreateWallet, useSignMessage, useSignTransaction, toSolanaWalletConnectors } from '@privy-io/react-auth/solana';

const UI = { showWalletUIs: true };
// Visible diagnostics: shown in the panel so the user does not need the console.
const plog = (m) => { console.log('[privy]', m); (window.__privyLog = window.__privyLog || []).push(new Date().toLocaleTimeString() + ' ' + m); window.__privyLog = window.__privyLog.slice(-6); window.dispatchEvent(new Event('privylog')); };
const dialogProbe = () => { const els = [...document.querySelectorAll('[id*="privy" i], [class*="privy" i], dialog, [role="dialog"], iframe')]; return els.slice(0, 8).map(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return `${e.tagName}#${e.id || ''} ${Math.round(r.width)}x${Math.round(r.height)} display=${cs.display} vis=${cs.visibility} z=${cs.zIndex}`; }).join(' | ') || 'no dialog/iframe elements found'; };

function Panel({ onWallets, headless }) {
  const { ready, authenticated, logout, user, getAccessToken } = usePrivy();
  const { identityToken } = useIdentityToken(), idt = useRef(null); idt.current = identityToken;
  const { login } = useLogin();
  const { createWallet } = useCreateWallet();
  const { ready: wReady, wallets } = useWallets();
  const { signMessage } = useSignMessage();
  const { signTransaction } = useSignTransaction();
  const [err, setErr] = React.useState('');
  const [, tick] = React.useReducer(x => x + 1, 0);
  useEffect(() => { window.addEventListener('privylog', tick); return () => window.removeEventListener('privylog', tick); }, []);
  // The hooks' functions can change between renders: always call the latest ones.
  const sm = useRef(signMessage), st = useRef(signTransaction);
  sm.current = signMessage; st.current = signTransaction;
  // Automatic trading: add or remove the server's signer on a Privy wallet. Privy shows the user what is being allowed; the policy id limits what the signer can sign.
  const { addSigners, removeSigners } = useSigners(), sg = useRef();
  sg.current = { addSigners, removeSigners, authenticated };
  // Base (MODE=base-mainnet): the user's Privy EMBEDDED Ethereum wallet (an external one cannot carry the server signer). create() makes one; sign(message) is personal_sign.
  const { wallets: evmAll } = useEvmWallets(), { createWallet: createEvm } = useCreateEvmWallet(), { signMessage: evmSign } = useEvmSignMessage(), { sendTransaction: evmSend } = useEvmSendTransaction(), ev = useRef();
  const evmWallet = evmAll.find(w => w.walletClientType === 'privy');
  ev.current = { evmWallet, createEvm, evmSign, evmSend };
  useEffect(() => {
    window.MintPrivy.evm = {
      address: () => (ev.current.evmWallet ? ev.current.evmWallet.address.toLowerCase() : null),
      create: async () => { if (!sg.current.authenticated) throw new Error('log in with Privy first'); if (ev.current.evmWallet) return ev.current.evmWallet.address.toLowerCase(); const w = await ev.current.createEvm(); return String(w.address).toLowerCase(); },
      sign: async (message) => { const w = ev.current.evmWallet; if (!w) throw new Error('create your Base wallet first');
        const r = await ev.current.evmSign({ message }, { address: w.address, uiOptions: { ...UI, title: 'Link to the MINT server', description: 'This only proves you control this wallet. It moves no funds.' } }); return r.signature; },
      // bridge-then-buy: the USER sends one checked Relay deposit on Base (apps/web/bridge.ts checks it first). Privy shows the amount and asks; the server signer is not used. Base only (supportedChains).
      send: async (tx, ui = {}) => { const w = ev.current.evmWallet; if (!w) throw new Error('create your Base wallet first'); if (Number(tx?.chainId) !== base.id) throw new Error('only Base transactions can be sent from this page');
        const r = await ev.current.evmSend({ to: tx.to, value: tx.value, data: tx.data, chainId: base.id }, { address: w.address, uiOptions: { ...UI, ...ui } }); return r.hash; },
    };
  }, []);
  useEffect(() => {
    const need = () => { if (!sg.current.authenticated) throw new Error('log in with Privy first'); };
    // policyIds: one id or a list (the server signer on an Ethereum wallet carries every EVM chain's policy: Base, Robinhood, BNB). Privy keeps one entry per signer, so
    // when the signer is already on the wallet (with fewer policies) it is removed and added again with the full list; Privy asks the user to approve each step.
    window.MintPrivy.allow = async (address, signerId, policyIds) => { need(); const ids = Array.isArray(policyIds) ? policyIds : [policyIds];
      try { await sg.current.addSigners({ address, signers: [{ signerId, policyIds: ids }] }); }
      catch (e) { if (!/already|exist|duplicate/i.test(String(e?.message ?? e))) throw e; await sg.current.removeSigners({ address }); await sg.current.addSigners({ address, signers: [{ signerId, policyIds: ids }] }); } };
    window.MintPrivy.revoke = async (address) => { need(); await sg.current.removeSigners({ address }); };
  }, []);

  const wrapped = React.useMemo(() => wallets.map(w => {
    const account = { address: w.address, publicKey: new Uint8Array(0), chains: ['solana:mainnet'], features: ['solana:signMessage', 'solana:signTransaction'] };
    return {
      name: 'Privy', icon: '', version: '1.0.0', chains: ['solana:mainnet'], accounts: [account],
      features: {
        'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
        'solana:signMessage': {
          version: '1.0.0',
          signMessage: async (...ins) => {
            const out = [];
            for (const i of ins) {
              const info = { address: w.address, keys: Object.keys(w), type: w.walletClientType || w.standardWallet?.name || w.name || 'unknown', msgType: Object.prototype.toString.call(i.message), len: i.message && i.message.length };
              plog('signMessage start: ' + JSON.stringify(info));
              setTimeout(() => plog('after 3s, page elements: ' + dialogProbe()), 3000);
              setTimeout(() => plog('after 15s, page elements: ' + dialogProbe()), 15000);
              // Path A: Privy's hook (shows its own dialog). Path B, started after 8 s if A is silent: the wallet object's own signMessage. First answer wins.
              const a = sm.current({ message: i.message, wallet: w, options: { uiOptions: { ...UI, title: 'Sign in to MINT', description: 'This only proves you control this wallet. It moves no funds.' } } });
              a.then(() => plog('hook path answered'), e => plog('hook path error: ' + ((e && e.message) || e)));
              const b = new Promise((res, rej) => setTimeout(() => { plog('hook silent for 8s: trying the wallet\'s own signMessage'); Promise.resolve().then(() => w.signMessage({ message: i.message })).then(x => { plog('direct path answered'); res(x); }, e => { plog('direct path error: ' + ((e && e.message) || e)); rej(e); }); }, 8000));
              b.catch(() => {});
              const t = new Promise((_, rej) => setTimeout(() => rej(new Error('Privy did not answer in 30 seconds on either path. Log: ' + (window.__privyLog || []).join(' || ') + ' || elements: ' + dialogProbe())), 30000));
              const r = await Promise.race([a, b, t]);
              console.log('[privy] signMessage done', r && Object.keys(r));
              const sig = r.signature instanceof Uint8Array ? r.signature : (typeof r.signature === 'string' ? Uint8Array.from(atob(r.signature), c => c.charCodeAt(0)) : r.signature);
              out.push({ signedMessage: i.message, signature: sig });
            }
            return out;
          },
        },
        'solana:signTransaction': {
          version: '1.0.0',
          signTransaction: async (...ins) => {
            const out = [];
            for (const i of ins) {
              console.log('[privy-sign] start', { bytes: i.transaction.length, wallet: w.address, version: i.transaction[65] });
              const timer = setTimeout(() => console.warn('[privy-sign] still no answer after 15s: the Privy signing screen did not resolve'), 15000);
              let r;
              try { r = await st.current({ transaction: i.transaction, wallet: w, chain: 'solana:mainnet', options: { uiOptions: { ...UI, description: 'Trade on MINT', buttonText: 'Approve', isCancellable: true } } }); }
              catch (e) { console.error('[privy-sign] error', e); throw e; }
              finally { clearTimeout(timer); }
              console.log('[privy-sign] done');
              let signed = r.signedTransaction;
              if (signed && signed.length === 64) { const tx = new Uint8Array(i.transaction); tx.set(signed, 1); signed = tx; }   // some wallets return only the 64-byte signature
              out.push({ signedTransaction: signed });
            }
            return out;
          },
        },
      },
    };
  }), [wallets.map(w => w.address).join('|')]);

  useEffect(() => { onWallets(authenticated && wReady ? wrapped : []); }, [authenticated, wReady, wrapped]);

  // headless (the /app trading app): no UI here; the app reads window.MintPrivy.session and listens for the "mintprivy" event, and draws its own screens
  useEffect(() => {
    window.MintPrivy.session = {
      ready, authenticated, email: (user && user.email && user.email.address) || null,
      solAddress: wallets[0] ? String(wallets[0].address) : null, evmAddress: evmWallet ? evmWallet.address.toLowerCase() : null,
      login: () => login(), logout: () => logout(),
      // the Privy login token, for the trading server's sign-in (POST /v1/auth/privy): the server checks Privy's signature and opens a session; no API key needed.
      // Right after a fresh login Privy can still be storing the token (seen live: null until a reload), so ask a few times, then fall back to the identity token
      // (also ES256, signed by Privy for this app, same claims the server checks).
      accessToken: async () => {
        for (let i = 0; i < 6; i++) {
          const t = (await getAccessToken().catch(() => null)) || (await getCustomerAccessToken().catch(() => null)) || idt.current || (await getIdentityToken().catch(() => null));
          if (t) return t;
          await new Promise(r => setTimeout(r, 400 * (i + 1)));
        }
        return null;
      },
      createSol: () => createWallet(), createEvm: () => ev.current.createEvm(),
    };
    window.dispatchEvent(new Event('mintprivy'));
  }, [ready, authenticated, user, wallets.map(w => w.address).join('|'), evmWallet && evmWallet.address]);
  if (headless) return null;
  if (!ready) return <span className="faint">Loading Privy…</span>;
  if (!authenticated) return <button className="btn primary" onClick={() => login()}>Log in with Privy</button>;
  const who = (user && user.email && user.email.address) || 'your Privy account';
  return (
    <span>
      <span className="faint">Signed in with Privy as {who}. </span>
      {wReady ? <span className="faint" style={{ display: 'block' }}>Privy has {wallets.length} Solana wallet{wallets.length === 1 ? '' : 's'}{wallets.map(w => ` · ${String(w.address).slice(0, 6)}…`).join('')}. </span> : null}
      {wReady && wallets.length === 0 ? (
        <span>
          <span className="faint">You have no Solana wallet yet. </span>
          <button className="btn" onClick={async () => { setErr(''); try { await createWallet(); } catch (e) { setErr(String((e && e.message) || e)); } }}>Create Solana wallet</button>{' '}
        </span>
      ) : null}
      {wReady && wallets.length > 0 ? <span className="faint">Choose it under "Sign in with your wallet" below. </span> : null}
      <span className="faint" style={{ display: 'block' }}>{evmWallet ? `Base wallet ${evmWallet.address.slice(0, 8)}…` : 'No Base wallet yet (create it in the Execution server box when the server runs MODE=base-mainnet).'}</span>
      {err ? <span className="dn">{err} </span> : null}
      <button className="btn" onClick={() => logout()}>Log out of Privy</button>
    </span>
  );
}

window.MintPrivy = {
  /** el: the element to render into. opts.appId: your Privy App ID (public). opts.onWallets(wallets): called with the user's Privy Solana wallets (empty when logged out). */
  mount(el, opts) {
    if (el.__root) return;
    el.__root = createRoot(el);
    el.__root.render(
      <PrivyProvider
        appId={opts.appId}
        config={{
          appearance: { walletChainType: 'solana-only', showWalletLoginFirst: false },
          loginMethods: ['email', 'wallet'],
          externalWallets: { solana: { connectors: toSolanaWalletConnectors() } },
          embeddedWallets: { solana: { createOnLogin: 'users-without-wallets' }, ethereum: { createOnLogin: 'off' }, showWalletUIs: true },
          defaultChain: base, supportedChains: [base],
          // Privy's approval screen reads fees and balances through this RPC and fails without it ("No RPC configuration found"). Display only: the server still builds and sends the trade. Goes through this terminal's read-only relay (/api/sol/rpc): the public endpoint answers browsers with 403.
          solana: { rpcs: { 'solana:mainnet': { rpc: createSolanaRpc(location.origin + '/api/sol/rpc'), rpcSubscriptions: createSolanaRpcSubscriptions('wss://api.mainnet-beta.solana.com') } } },
        }}
      >
        <Panel onWallets={opts.onWallets} headless={!!opts.headless} />
      </PrivyProvider>
    );
  },
};
