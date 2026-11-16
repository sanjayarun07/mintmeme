/* Privy login for the terminal's Solana page. Privy's browser SDK is React-only, so this tiny React app is bundled separately and mounted into one box on the page.
 * After login, Privy's Solana wallets are handed to the page wrapped as Wallet Standard wallets, so the page treats them exactly like Phantom or Solflare. Signing goes through Privy's own
 * signMessage / signTransaction hooks with wallet dialogs turned on, so the user sees and approves what is signed. This file never sees or sends a trade: it logs in, lists wallets and signs on request. */
import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy, useLogin } from '@privy-io/react-auth';
import { useWallets, useCreateWallet, useSignMessage, useSignTransaction, toSolanaWalletConnectors } from '@privy-io/react-auth/solana';

const UI = { showWalletUIs: true };

function Panel({ onWallets }) {
  const { ready, authenticated, logout, user } = usePrivy();
  const { login } = useLogin();
  const { createWallet } = useCreateWallet();
  const { ready: wReady, wallets } = useWallets();
  const { signMessage } = useSignMessage();
  const { signTransaction } = useSignTransaction();
  const [err, setErr] = React.useState('');
  // The hooks' functions can change between renders: always call the latest ones.
  const sm = useRef(signMessage), st = useRef(signTransaction);
  sm.current = signMessage; st.current = signTransaction;

  const wrapped = React.useMemo(() => wallets.map(w => {
    const account = { address: w.address, publicKey: new Uint8Array(0), chains: ['solana:mainnet'], features: ['solana:signMessage', 'solana:signTransaction'] };
    return {
      name: 'Privy', icon: '', version: '1.0.0', chains: ['solana:mainnet'], accounts: [account],
      features: {
        'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
        'solana:signMessage': {
          version: '1.0.0',
          signMessage: async (...ins) => { const out = []; for (const i of ins) { const r = await sm.current({ message: i.message, wallet: w, options: { uiOptions: { ...UI, title: 'Sign in to MINT', description: 'This only proves you control this wallet. It moves no funds.' } } }); out.push({ signedMessage: i.message, signature: r.signature }); } return out; },
        },
        'solana:signTransaction': {
          version: '1.0.0',
          signTransaction: async (...ins) => {
            const out = [];
            for (const i of ins) {
              const r = await st.current({ transaction: i.transaction, wallet: w, chain: 'solana:mainnet', options: { uiOptions: { ...UI } } });
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

  if (!ready) return <span className="faint">Loading Privy…</span>;
  if (!authenticated) return <button className="btn primary" onClick={() => login()}>Log in with Privy</button>;
  const who = (user && user.email && user.email.address) || 'your Privy account';
  return (
    <span>
      <span className="faint">Privy: {who}. </span>
      {wReady ? <span className="faint" style={{ display: 'block' }}>Privy has {wallets.length} Solana wallet{wallets.length === 1 ? '' : 's'}{wallets.map(w => ` · ${String(w.address).slice(0, 6)}…`).join('')}. </span> : null}
      {wReady && wallets.length === 0 ? (
        <span>
          <span className="faint">You have no Solana wallet yet. </span>
          <button className="btn" onClick={async () => { setErr(''); try { await createWallet(); } catch (e) { setErr(String((e && e.message) || e)); } }}>Create Solana wallet</button>{' '}
        </span>
      ) : null}
      {wReady && wallets.length > 0 ? <span className="faint">Choose it under "Sign in with your wallet" below. </span> : null}
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
          embeddedWallets: { solana: { createOnLogin: 'users-without-wallets' }, showWalletUIs: true },
        }}
      >
        <Panel onWallets={opts.onWallets} />
      </PrivyProvider>
    );
  },
};
