import { formatKT } from "../lib/units.js";
import { Notice, UnsolicitedWarning } from "./common.jsx";

/** Financial transparency: actual balance vs recorded liabilities (solvency guard). */
export function SolvencyPanel({ manager }) {
  return (
    <section className="card" aria-labelledby="solvency-title" data-testid="solvency-panel">
      <h2 id="solvency-title">CampaignManager solvency</h2>
      <dl className="facts">
        <div><dt>Actual KT balance</dt><dd data-testid="sp-balance">{formatKT(manager.tokenBalance)}</dd></div>
        <div><dt>Recorded liabilities</dt><dd data-testid="sp-liabilities">{formatKT(manager.totalOutstanding)}</dd></div>
        <div><dt>Status</dt><dd data-testid="sp-status">{manager.isSolvent ? "Solvent" : "INSOLVENT"}</dd></div>
        <div><dt>Excess (unsolicited, locked)</dt><dd>{formatKT(manager.excessBalance)}</dd></div>
        <div><dt>Shortfall</dt><dd>{formatKT(manager.shortfall)}</dd></div>
        <div><dt>Unclaimed platform fees</dt><dd>{formatKT(manager.platformFeesOutstanding)}</dd></div>
      </dl>
      {!manager.isSolvent && <InsolvencyNotice />}
      <UnsolicitedWarning />
    </section>
  );
}

export function InsolvencyNotice() {
  return (
    <Notice tone="bad" title="Contributions and claims are unavailable." testId="insolvency-notice">
      The contract's KT balance is below its recorded liabilities. Its deterministic solvency rule blocks every
      contribution and outgoing claim until backing is restored. Finalization and read-only monitoring still work.
      No administrator can override this rule, and entitlements stay recorded unchanged.
    </Notice>
  );
}
