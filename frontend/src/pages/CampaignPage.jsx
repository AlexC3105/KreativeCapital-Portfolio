import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Address, Field, Notice, PhaseBadge, Progress, QueryState, SelfFundingNote, TxStatus } from "../components/common.jsx";
import { InsolvencyNotice } from "../components/SolvencyPanel.jsx";
import { Phase } from "../lib/api.js";
import { TxState } from "../lib/tx.js";
import { formatKT, formatRemaining, formatTimestamp, parseAmount, settlementSplit } from "../lib/units.js";
import { useApp, useChainQuery, useTx } from "../state/AppContext.js";

function ContributePanel({ campaign, me, solvent }) {
  const { actions, writeBlockedReason } = useApp();
  const tx = useTx(`campaign:${campaign.id}:contribute`);
  const [raw, setRaw] = useState("");
  // After a verified contribution, clear the amount so the (now consumed) allowance does not
  // prompt an accidental second approval for the same amount.
  useEffect(() => {
    if (tx.record?.state === TxState.CONFIRMED && tx.record.label.startsWith("Contribute")) setRaw("");
  }, [tx.record]);
  const parsed = raw === "" ? null : parseAmount(raw);
  let error = parsed?.error ?? null;
  if (!error && parsed && me && parsed.value > me.balance) error = `Your KT balance (${formatKT(me.balance)}) is too low.`;
  const amount = parsed && !error ? parsed.value : null;
  const needsApproval = amount !== null && me && me.allowance < amount;
  const blocked = writeBlockedReason ?? (!solvent ? "Contributions are paused by the solvency rule." : null);
  const failedAfterApproval = tx.record && tx.record.label.startsWith("Contribute") && tx.record.state !== TxState.CONFIRMED && me?.allowance > 0n;

  return (
    <section className="card" aria-labelledby="contribute-title">
      <h2 id="contribute-title">Contribute</h2>
      {me && (
        <p className="muted">
          Your KT balance: <span data-testid="my-balance">{formatKT(me.balance)}</span> · current allowance for CampaignManager:{" "}
          <span data-testid="my-allowance">{formatKT(me.allowance)}</span>
        </p>
      )}
      <Field id="contribution" label="Amount (KT)" hint="Exact decimal amount, up to 18 decimal places." error={error}>
        <input id="contribution" inputMode="decimal" autoComplete="off" value={raw} onChange={(e) => setRaw(e.target.value)} aria-describedby="contribution-hint" data-testid="contribution-input" />
      </Field>
      {blocked && <p className="muted" data-testid="contribute-blocked">{blocked}</p>}
      <div className="actions">
        {needsApproval ? (
          <button type="button" className="btn" disabled={!!blocked || tx.busy} data-testid="approve-button" onClick={() => tx.run((u) => actions.approve(amount, u))}>
            Step 1: Approve exactly {formatKT(amount)}
          </button>
        ) : (
          <button type="button" className="btn" disabled={!!blocked || tx.busy || amount === null} data-testid="contribute-button" onClick={() => tx.run((u) => actions.contribute(campaign.id, amount, u))}>
            {amount !== null && me?.allowance >= amount ? "Step 2: " : ""}Contribute {amount !== null ? formatKT(amount) : ""}
          </button>
        )}
      </div>
      <p className="hint">Approvals are always for the exact amount. There are no unlimited allowances.</p>
      <TxStatus tx={tx} />
      {failedAfterApproval && (
        <Notice tone="warn" testId="remaining-allowance">
          The contribution did not complete. CampaignManager still holds an allowance of {formatKT(me.allowance)} from your
          account. You can use it for a new attempt or revoke it.{" "}
          <button type="button" className="btn btn-small" disabled={!!writeBlockedReason || tx.busy} onClick={() => tx.run((u) => actions.approve(0n, u))}>Revoke allowance</button>
        </Notice>
      )}
    </section>
  );
}

function SettlementPanel({ campaign, me, solvent }) {
  const { actions, wallet, writeBlockedReason } = useApp();
  const tx = useTx(`campaign:${campaign.id}:settlement`);
  const account = wallet.status === "connected" ? wallet.account : null;
  const claimsBlocked = writeBlockedReason ?? (!solvent ? "Claims are paused by the solvency rule." : null);
  const isCreator = account && account === campaign.creator;

  return (
    <section className="card" aria-labelledby="settle-title">
      <h2 id="settle-title">Finalization and claims</h2>
      {campaign.phase === Phase.Open && <p>Contributions are open until the deadline. Finalization becomes available to anyone at the deadline.</p>}
      {campaign.phase === Phase.AwaitingFinalization && (
        <>
          <p>The deadline has passed. Anyone may finalize, and the outcome is decided by the recorded contributions.</p>
          <button type="button" className="btn" disabled={!!writeBlockedReason || tx.busy} data-testid="finalize-button" onClick={() => tx.run((u) => actions.finalize(campaign.id, u))}>Finalize campaign</button>
        </>
      )}
      {campaign.phase === Phase.Successful && (
        <>
          <p>Goal met. Fee: {formatKT(campaign.platformFee)} (1%, rounded down) · creator entitlement: {formatKT(campaign.creatorEntitlement)}.</p>
          {campaign.creatorPaid ? (
            <p data-testid="payout-claimed">The creator payout has been claimed.</p>
          ) : isCreator ? (
            <button type="button" className="btn" disabled={!!claimsBlocked || tx.busy} data-testid="claim-payout-button" onClick={() => tx.run((u) => actions.claimCreatorPayout(campaign.id, u))}>Claim {formatKT(campaign.creatorEntitlement)}</button>
          ) : (
            <p className="muted">Only the creator can claim the payout.</p>
          )}
        </>
      )}
      {campaign.phase === Phase.Failed && (
        <>
          <p>Goal missed. Every contributor can reclaim 100% of their recorded contribution. No fee is charged.</p>
          {me && me.contribution > 0n ? (
            me.refunded ? (
              <p data-testid="refund-claimed">Your refund of {formatKT(me.contribution)} has been claimed.</p>
            ) : (
              <button type="button" className="btn" disabled={!!claimsBlocked || tx.busy} data-testid="claim-refund-button" onClick={() => tx.run((u) => actions.claimRefund(campaign.id, u))}>Reclaim {formatKT(me.contribution)}</button>
            )
          ) : (
            <p className="muted">{account ? "This account has no recorded contribution to this campaign." : "Connect a wallet to see your refund."}</p>
          )}
        </>
      )}
      {claimsBlocked && campaign.phase >= Phase.Successful && <p className="muted">{claimsBlocked}</p>}
      <TxStatus tx={tx} />
    </section>
  );
}

export function CampaignPage() {
  const { id: rawId } = useParams();
  const { wallet } = useApp();
  const valid = /^[1-9]\d*$/.test(rawId ?? "");
  const id = valid ? BigInt(rawId) : null;
  const account = wallet.status === "connected" ? wallet.account : null;
  const q = useChainQuery((api) => (id ? Promise.all([api.getCampaign(id, account), api.manager.isSolvent()]) : Promise.resolve([null, true])), [rawId, account]);
  if (!valid) return <Notice tone="bad">Invalid campaign id.</Notice>;
  return (
    <QueryState state={q} empty={Object.assign((d) => d[0] === null, { message: `Campaign #${rawId} does not exist.` })}>
      {([data, solvent]) => {
        const { campaign: c, me, now } = data;
        const split = settlementSplit(c.totalContributed);
        return (
          <>
            <p><Link to="/">← All campaigns</Link></p>
            <article className="card" data-testid="campaign-detail">
              <header className="card-header">
                <h1>#{String(c.id)} · {c.name}</h1>
                <PhaseBadge phase={c.phase} />
              </header>
              {c.description && <p className="description">{c.description}</p>}
              <dl className="facts">
                <div><dt>Creator</dt><dd><Address value={c.creator} label="creator" /></dd></div>
                <div><dt>Goal</dt><dd>{formatKT(c.goal)}</dd></div>
                <div><dt>Recorded contributions</dt><dd data-testid="detail-total">{formatKT(c.totalContributed)}</dd></div>
                <div><dt>Deadline</dt><dd>{formatTimestamp(c.deadline)} ({formatRemaining(c.deadline, now)})</dd></div>
                <div><dt>Outstanding in escrow / entitlements</dt><dd>{formatKT(c.outstanding)}</dd></div>
                {c.phase <= Phase.AwaitingFinalization && (
                  <div><dt>If successful at the current total</dt><dd>fee {formatKT(split.fee)} · creator {formatKT(split.creator)}</dd></div>
                )}
                {me && <div><dt>Your recorded contribution</dt><dd data-testid="my-contribution">{formatKT(me.contribution)}</dd></div>}
              </dl>
              <Progress total={c.totalContributed} goal={c.goal} />
              <SelfFundingNote />
            </article>
            {!solvent && <InsolvencyNotice />}
            {c.phase === Phase.Open && <ContributePanel campaign={c} me={me} solvent={solvent} />}
            <SettlementPanel campaign={c} me={me} solvent={solvent} />
          </>
        );
      }}
    </QueryState>
  );
}
