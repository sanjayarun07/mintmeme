/* Privy login for the terminal's Solana page. Privy's browser SDK is React-only, so this tiny React app is bundled separately and mounted into one box on the page.
 * After the user logs in, Privy's Solana wallets (its embedded wallet, plus any external wallet the user links) are handed to the page as Wallet Standard wallets, so the page treats them
 * exactly like Phantom or Solflare: the user signs a login message, and every trade is signed in the wallet. This file never sees or sends any trade; it only logs in and lists wallets. */
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy, useLogin } from '@privy-io/react-auth';
import { useStandardWallets, toSolanaWalletConnectors } from '@privy-io/react-auth/solana';

function Panel({ onWallets }) {
  const { ready, authenticated, logout, user } = usePrivy();
  const { login } = useLogin();
  const { ready: wReady, wallets } = useStandardWallets();   // exported under this name in @privy-io/react-auth 3.51.4 (the docs call it useSolanaStandardWallets)
  useEffect(() => { onWallets(authenticated && wReady ? wallets : []); }, [authenticated, wReady, wallets]);
  if (!ready) return <span className="faint">Loading Privy…</span>;
  if (!authenticated) return <button className="btn primary" onClick={() => login()}>Log in with Privy</button>;
  const who = (user && (user.email && user.email.address)) || 'your Privy account';
  return (
    <span>
      <span className="faint">Privy: {who}. </span>
      {wReady && wallets.length === 0 ? <span className="faint">No Solana wallet yet: Privy is creating one… </span> : null}
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
          embeddedWallets: { solana: { createOnLogin: 'users-without-wallets' } },
        }}
      >
        <Panel onWallets={opts.onWallets} />
      </PrivyProvider>
    );
  },
};
