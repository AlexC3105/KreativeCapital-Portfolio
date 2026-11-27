import { Link } from "react-router-dom";
import { Address, Notice, PhaseBadge, QueryState, TxStatus } from "../components/common.jsx";
import { InsolvencyNotice } from "../components/SolvencyPanel.jsx";
import { formatEth, formatKT } from "../lib/units.js";
import { useApp, useChainQuery, useTx } from "../state/AppContext.js";

function CampaignLink({ c }) {
  return <Link to={`/campaigns/${c.id}`}>#{String(c.id)} · {c.name}</Link>;
}

export function AccountPage() {
  const { wallet, actions, writeBlockedReason } = useApp();
  const account = wallet.status === "connected" ? wallet.account : null;
  const tx = useTx("account");
  const q = useChainQuery(
    async (api) => (account ? { me: await api.getAccount(account), platform: await api.getPlatform() } : null),
    [account]
  );
  if (!account) return <Notice tone="info">Connect a wallet to see balances, campaigns, contributions and claims for your account.</Notice>;

  return (
    <QueryState state={q}>
      {({ me, platform }) => {
        const solvent = platform.manager.isSolvent;
        const claimsBlocked = writeBlockedReason ?? (!solvent ? "Claims are paused by the solvency rule." : null);
        return (
          <>
            <h1>My account <Address value={me.account} label="account" /></h1>
            {!solvent && <InsolvencyNotice />}
            <TxStatus tx={tx} />
            <section className="card" aria-labelledby="bal-title">
              <h2 id="bal-title">Balances</h2>
              <dl className="facts">
                <div><dt>Local ETH</dt><dd data-testid="acct-eth">{formatEth(me.eth)}</dd></div>
                <div><dt>KT</dt><dd data-testid="acct-kt">{formatKT(me.kt)}</dd></div>
                <div><dt>Allowance for CampaignManager</dt><dd data-testid="acct-allowance">{formatKT(me.allowance)}</dd></div>
              </dl>
              {me.allowance > 0n && (
                <button type="button" className="btn btn-small" disabled={!!writeBlockedReason || tx.busy} data-testid="revoke-button" onClick={() => tx.run((u) => actions.approve(0n, u))}>
                  Revoke allowance
                </button>
              )}
            </section>

            <section className="card" aria-labelledby="payout-title">
              <h2 id="payout-title">Campaigns you created ({me.created.length})</h2>
              {me.created.length === 0 ? <p className="muted">None.</p> : (
                <ul className="rows">
                  {me.created.map((c) => (
                    <li key={String(c.id)}>
                      <CampaignLink c={c} /> <PhaseBadge phase={c.phase} /> · raised {formatKT(c.totalContributed)} of {formatKT(c.goal)}
                      {c.status === 1 && !c.creatorPaid && (
                        <button type="button" className="btn btn-small" disabled={!!claimsBlocked || tx.busy} data-testid={`payout-${c.id}`} onClick={() => tx.run((u) => actions.claimCreatorPayout(c.id, u))}>
                          Claim {formatKT(c.creatorEntitlement)}
                        </button>
                      )}
                      {c.status === 1 && c.creatorPaid && <span className="muted"> · payout claimed</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card" aria-labelledby="contrib-title">
              <h2 id="contrib-title">Your recorded contributions ({me.contributions.length})</h2>
              {me.contributions.length === 0 ? <p className="muted">None.</p> : (
                <ul className="rows">
                  {me.contributions.map(({ campaign: c, amount, refunded }) => (
                    <li key={String(c.id)}>
                      <CampaignLink c={c} /> <PhaseBadge phase={c.phase} /> · {formatKT(amount)}
                      {c.status === 2 && !refunded && (
                        <button type="button" className="btn btn-small" disabled={!!claimsBlocked || tx.busy} data-testid={`refund-${c.id}`} onClick={() => tx.run((u) => actions.claimRefund(c.id, u))}>
                          Reclaim {formatKT(amount)}
                        </button>
                      )}
                      {c.status === 2 && refunded && <span className="muted"> · refunded</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card" aria-labelledby="owner-title" data-testid="owner-section">
              <h2 id="owner-title">Platform owner functions</h2>
              <p className="muted">
                Shown according to verified on-chain ownership. CampaignManager owner: <Address value={platform.manager.owner} /> · KreativeToken
                owner: <Address value={platform.token.owner} />. The contracts enforce authorization, and the interface cannot bypass it.
              </p>
              {me.isManagerOwner ? (
                <p>
                  Unclaimed platform fees: <span data-testid="owner-fees">{formatKT(me.platformFeesOutstanding)}</span>{" "}
                  <button type="button" className="btn btn-small" disabled={!!claimsBlocked || tx.busy || me.platformFeesOutstanding === 0n} data-testid="claim-fees-button" onClick={() => tx.run((u) => actions.claimPlatformFees(u))}>
                    Claim platform fees
                  </button>
                </p>
              ) : (
                <p data-testid="not-manager-owner">This account is not the CampaignManager owner, so it cannot claim platform fees.</p>
              )}
              {me.isTokenOwner ? (
                <p>
                  Recorded, unwithdrawn sale proceeds: {formatEth(me.unwithdrawnProceeds)}{" "}
                  <button type="button" className="btn btn-small" disabled={!!writeBlockedReason || tx.busy || me.unwithdrawnProceeds === 0n} data-testid="withdraw-proceeds-button" onClick={() => tx.run((u) => actions.withdrawProceeds(u))}>
                    Withdraw proceeds
                  </button>
                </p>
              ) : (
                <p data-testid="not-token-owner">This account is not the KreativeToken owner, so it cannot withdraw sale proceeds.</p>
              )}
            </section>
          </>
        );
      }}
    </QueryState>
  );
}
