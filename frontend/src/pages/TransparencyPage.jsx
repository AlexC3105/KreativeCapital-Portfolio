import { Address, QueryState } from "../components/common.jsx";
import { SolvencyPanel } from "../components/SolvencyPanel.jsx";
import { formatEth, formatKT } from "../lib/units.js";
import { useApp, useChainQuery } from "../state/AppContext.js";

function VerificationList() {
  const { deployment } = useApp();
  return (
    <section className="card" aria-labelledby="verify-title" data-testid="verification">
      <h2 id="verify-title">Deployment verification: {deployment.status}</h2>
      {deployment.manifest && (
        <p className="muted">
          Chain 31337 at {deployment.manifest.rpcUrl} · KreativeToken <Address value={deployment.manifest.contracts.KreativeToken.address} /> ·
          CampaignManager <Address value={deployment.manifest.contracts.CampaignManager.address} />
        </p>
      )}
      {deployment.checks ? (
        <ul className="checks">
          {deployment.checks.map((c) => (
            <li key={c.id} className={c.ok ? "check-ok" : "check-bad"}>
              <span aria-hidden="true">{c.ok ? "✔" : "✖"}</span> {c.label}
              <span className="sr-only">{c.ok ? " passed" : " failed"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{deployment.message ?? "Not available."}</p>
      )}
    </section>
  );
}

export function TransparencyPage() {
  const q = useChainQuery((api) => api.getPlatform(), []);
  return (
    <>
      <h1>Transparency</h1>
      <VerificationList />
      <QueryState state={q}>
        {(p) => (
          <>
            <SolvencyPanel manager={p.manager} />
            <section className="card" aria-labelledby="token-title">
              <h2 id="token-title">KreativeToken</h2>
              <dl className="facts">
                <div><dt>Fixed total supply</dt><dd>{formatKT(p.token.totalSupply)}</dd></div>
                <div><dt>Remaining sale reserve (recorded)</dt><dd>{formatKT(p.token.saleReserve)}</dd></div>
                <div><dt>Tokens sold</dt><dd>{formatKT(p.token.tokensSold)}</dd></div>
                <div><dt>Recorded sale proceeds</dt><dd>{formatEth(p.token.totalProceeds)}</dd></div>
                <div><dt>Proceeds withdrawn</dt><dd>{formatEth(p.token.proceedsWithdrawn)}</dd></div>
                <div><dt>Unwithdrawn proceeds</dt><dd>{formatEth(p.token.unwithdrawnProceeds)}</dd></div>
                <div><dt>Unsolicited KT at the token contract (locked)</dt><dd>{formatKT(p.token.unsolicitedTokenBalance)}</dd></div>
                <div><dt>Unsolicited ETH (locked)</dt><dd>{formatEth(p.token.unsolicitedEthBalance)}</dd></div>
                <div><dt>Owner</dt><dd><Address value={p.token.owner} /></dd></div>
              </dl>
              <p className="muted small">No minting, no redemption, no backing. The owner can withdraw only recorded sale proceeds. The sale reserve and campaign escrow are not accessible to anyone except through purchases and the campaign rules.</p>
            </section>
          </>
        )}
      </QueryState>
    </>
  );
}
