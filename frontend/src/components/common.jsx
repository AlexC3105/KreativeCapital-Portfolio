import { Link } from "react-router-dom";
import { PHASE_LABELS } from "../lib/api.js";
import { STATE_LABELS, TxState } from "../lib/tx.js";
import { formatKT, formatRemaining, formatTimestamp, shortAddress } from "../lib/units.js";

export function PhaseBadge({ phase }) {
  const cls = ["open", "awaiting", "successful", "failed"][phase];
  return <span className={`badge badge-${cls}`}>{PHASE_LABELS[phase]}</span>;
}

export function Address({ value, label }) {
  if (!value) return null;
  return (
    <span className="address-wrap">
      <span className="sr-only">{label ? `${label} ${value}` : value}</span>
      <code className="address" title={value} aria-hidden="true">
        {shortAddress(value)}
      </code>
    </span>
  );
}

/** Progress as an exact bigint ratio; only the final percentage is converted for display. */
export function Progress({ total, goal }) {
  const basisPoints = goal > 0n ? (total * 10_000n) / goal : 0n;
  const pct = Number(basisPoints > 10_000n ? 10_000n : basisPoints) / 100;
  const label = `${Number(basisPoints) / 100}% of goal`;
  return (
    <div className="progress-wrap">
      <div className="progress" aria-hidden="true">
        <div className="progress-bar" style={{ width: `${pct}%` }} />
      </div>
      <p className="progress-label">{label}</p>
    </div>
  );
}

export function CampaignCard({ campaign, now }) {
  return (
    <article className="card campaign-card" data-testid={`campaign-card-${campaign.id}`}>
      <header className="card-header">
        <h3>
          <Link to={`/campaigns/${campaign.id}`}>
            #{String(campaign.id)} · {campaign.name}
          </Link>
        </h3>
        <PhaseBadge phase={campaign.phase} />
      </header>
      {campaign.description && <p className="description">{campaign.description}</p>}
      <dl className="facts">
        <div><dt>Creator</dt><dd><Address value={campaign.creator} label="creator" /></dd></div>
        <div><dt>Goal</dt><dd>{formatKT(campaign.goal)}</dd></div>
        <div><dt>Recorded contributions</dt><dd>{formatKT(campaign.totalContributed)}</dd></div>
        <div><dt>Deadline</dt><dd>{formatTimestamp(campaign.deadline)}{campaign.phase === 0 && now ? ` (${formatRemaining(campaign.deadline, now)})` : ""}</dd></div>
      </dl>
      <Progress total={campaign.totalContributed} goal={campaign.goal} />
    </article>
  );
}

export function TxStatus({ record: recordProp, tx }) {
  const record = recordProp ?? tx?.record;
  if (!record) return null;
  const tone =
    record.state === TxState.CONFIRMED ? "ok" : [TxState.BLOCKED, TxState.REJECTED, TxState.REVERTED].includes(record.state) ? "bad" : record.state === TxState.UNKNOWN ? "warn" : "info";
  const unresolved = tx?.unresolved && record.state === TxState.UNKNOWN;
  return (
    <div className={`tx tx-${tone}`} role="status" aria-live="polite" data-testid="tx-status" data-state={record.state}>
      <strong>{record.label}:</strong> {STATE_LABELS[record.state]}
      {record.message && <p>{record.message}</p>}
      <p className="tx-meta">
        {record.from && <>From <Address value={record.from} label="from account" /> </>}
        {record.hash && <>· tx <code title={record.hash}>{record.hash.slice(0, 10)}…</code> </>}
        {record.blockNumber !== undefined && <>· block {record.blockNumber}</>}
      </p>
      {unresolved && (
        <div className="actions" data-testid="tx-unresolved">
          {tx.unresolved.resolve && (
            <button type="button" className="btn btn-small" onClick={tx.reconcile} disabled={tx.checking} data-testid="tx-check-status">
              {tx.checking ? "Checking…" : "Check status"}
            </button>
          )}
          <button type="button" className="btn btn-small" onClick={tx.acknowledge} data-testid="tx-acknowledge">I have checked my wallet</button>
          <p className="small">
            New actions in this section are paused until this is resolved. The pause lasts while this tab stays open.
            {record.hash && <> Full hash: <code className="address">{record.hash}</code></>}
          </p>
        </div>
      )}
    </div>
  );
}

export function Notice({ tone = "info", title, children, testId }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === "bad" ? "alert" : "note"} data-testid={testId}>
      {title && <strong>{title} </strong>}
      {children}
    </div>
  );
}

export function UnsolicitedWarning() {
  return (
    <Notice tone="warn" title="Do not send KT directly to the contracts.">
      Direct token transfers to CampaignManager or KreativeToken are not campaign contributions, do not create refund
      rights and cannot be recovered.
    </Notice>
  );
}

export function SelfFundingNote() {
  return (
    <p className="muted small">
      Creators may contribute to their own campaigns under the same rules as everyone else, so a funding total does not
      prove independent third-party demand.
    </p>
  );
}

export function Field({ id, label, hint, error, children }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <p className="hint" id={`${id}-hint`}>{hint}</p>}
      {error && <p className="field-error" id={`${id}-error`} role="alert">{error}</p>}
    </div>
  );
}

export function QueryState({ state, empty, children }) {
  if (state.unavailable) return <Notice tone="warn" testId="data-unavailable">Data is unavailable until the local deployment is verified.</Notice>;
  if (state.loading) return <p className="muted" role="status">Loading from the local chain…</p>;
  if (state.error) return <Notice tone="bad" testId="data-error">Could not read from the local chain: {state.error.shortMessage ?? state.error.message}</Notice>;
  if (empty?.(state.data)) return <p className="muted" data-testid="empty-state">{empty.message ?? "Nothing here yet."}</p>;
  return children(state.data);
}
