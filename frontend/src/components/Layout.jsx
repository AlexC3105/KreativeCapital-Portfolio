import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { useApp } from "../state/AppContext.js";
import { Address, Notice } from "./common.jsx";

const LINKS = [
  ["/", "Campaigns"],
  ["/create", "Create campaign"],
  ["/tokens", "Get KT"],
  ["/account", "My account"],
  ["/transparency", "Transparency"],
];

function WalletControl() {
  const { wallet, connect, disconnect } = useApp();
  if (wallet.status === "connected") {
    return (
      <div className="wallet" data-testid="wallet-connected">
        <span className={wallet.chainOk ? "dot dot-ok" : "dot dot-bad"} aria-hidden="true" />
        <Address value={wallet.account} label="connected account" />
        <button type="button" className="btn btn-small" onClick={disconnect}>Disconnect</button>
      </div>
    );
  }
  return (
    <button type="button" className="btn" onClick={connect} disabled={wallet.status === "connecting" || wallet.status === "choosing"} data-testid="connect-wallet">
      {wallet.status === "connecting" ? "Connecting…" : wallet.status === "choosing" ? "Choose a wallet…" : "Connect wallet"}
    </button>
  );
}

function WalletPicker() {
  const { wallet, selectWallet, cancelWalletChoice } = useApp();
  const firstRef = useRef(null);
  useEffect(() => {
    firstRef.current?.focus();
  }, []);
  return (
    <div className="dialog-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-picker-title"
        className="dialog card"
        data-testid="wallet-picker"
        onKeyDown={(e) => e.key === "Escape" && cancelWalletChoice()}
      >
        <h2 id="wallet-picker-title">Choose a wallet</h2>
        <p className="muted">Several browser wallets were detected. Choose the one holding your disposable local development account.</p>
        <ul className="rows">
          {wallet.options.map((o, i) => (
            <li key={o.id}>
              <button type="button" className="btn" ref={i === 0 ? firstRef : undefined} onClick={() => selectWallet(o.id)} data-testid={`wallet-option-${i}`}>
                {o.name}
              </button>{" "}
              <span className="muted small">{o.rdns}</span>
            </li>
          ))}
        </ul>
        <button type="button" className="btn btn-small" onClick={cancelWalletChoice} data-testid="wallet-picker-cancel">Cancel</button>
      </div>
    </div>
  );
}

function StatusBanners() {
  const { deployment, wallet } = useApp();
  const banners = [];
  const d = deployment;
  if (d.status === "loading") banners.push(<Notice key="d" tone="info">Verifying the local deployment…</Notice>);
  if (["missing", "invalid", "unavailable"].includes(d.status)) banners.push(<Notice key="d" tone="bad" title="No verified deployment." testId="deployment-banner">{d.message}</Notice>);
  if (d.status === "rpc-unavailable") banners.push(<Notice key="d" tone="bad" title="Local chain unavailable." testId="deployment-banner">{d.message} Start it with "npm run node".</Notice>);
  if (d.status === "stale") banners.push(<Notice key="d" tone="bad" title="Stale deployment manifest." testId="deployment-banner">The local chain no longer matches the deployment manifest (the node was probably restarted). Redeploy with "npm run deploy:local". Financial writes are disabled.</Notice>);
  if (d.status === "unverified") banners.push(<Notice key="d" tone="bad" title="Deployment verification failed." testId="deployment-banner">The contracts on the local chain do not match the expected artifacts. Financial writes are disabled. See Transparency for details.</Notice>);
  if (wallet.status === "connected" && !wallet.chainOk) banners.push(<Notice key="w" tone="bad" title="Wrong network." testId="network-banner">{wallet.chainReason} Financial writes are disabled.</Notice>);
  if (wallet.status === "unavailable" || (wallet.status === "disconnected" && wallet.message)) banners.push(<Notice key="w2" tone="warn">{wallet.message}</Notice>);
  // A labelled landmark when banners are shown, so status messages (including the transient
  // "Verifying" notice) sit inside a page region for assistive technology.
  if (banners.length === 0) return <div className="banners" />;
  return (
    <div className="banners" role="region" aria-label="Status messages">
      {banners}
    </div>
  );
}

export function Layout({ children }) {
  const [open, setOpen] = useState(false);
  const { wallet } = useApp();
  return (
    <div className="app">
      <a className="skip-link" href="#main">Skip to content</a>
      <aside className="dev-banner" aria-label="Project notice">
        <p>Local development only · Educational project · KT has no value, no redemption rights and no backing</p>
      </aside>
      <header className="navbar">
        <NavLink to="/" className="brand glow-text">KreativeCapital</NavLink>
        <button type="button" className="btn btn-small nav-toggle" aria-expanded={open} aria-controls="primary-nav" onClick={() => setOpen((o) => !o)}>
          Menu
        </button>
        <nav id="primary-nav" aria-label="Primary" className={open ? "nav open" : "nav"}>
          <ul>
            {LINKS.map(([to, label]) => (
              <li key={to}>
                <NavLink to={to} end={to === "/"} onClick={() => setOpen(false)}>{label}</NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <WalletControl />
      </header>
      <StatusBanners />
      {wallet.status === "choosing" && <WalletPicker />}
      <main id="main" tabIndex={-1}>{children}</main>
      <footer className="footer">
        <p>Developed by Alexandr Climenco for UM FinTech Bootcamp © 2024 · Modernized 2026</p>
        <p className="small">Unaudited educational code for a local development chain. Not for real funds.</p>
      </footer>
    </div>
  );
}
