import { EXAMPLE_CAMPAIGNS, EXAMPLE_DISCLAIMER } from "../lib/examples.js";
import { formatKT } from "../lib/units.js";
import { Notice, PhaseBadge, Progress } from "./common.jsx";

/** Static, clearly labelled example cards: no links, no actions, no chain access. */
function ExampleCard({ example }) {
  return (
    <article className="card campaign-card example-card" data-testid={`example-card-${example.key}`} aria-label={`Example campaign: ${example.name}`}>
      <header className="card-header">
        <h3>{example.name}</h3>
        <span className="badges">
          <span className="badge badge-example">Example</span> <PhaseBadge phase={example.phase} />
        </span>
      </header>
      <p className="description">{example.description}</p>
      <dl className="facts">
        <div><dt>Goal</dt><dd>{formatKT(example.goal)}</dd></div>
        <div><dt>Contributed (illustrative)</dt><dd>{formatKT(example.totalContributed)}</dd></div>
        <div><dt>Status</dt><dd>{example.status}</dd></div>
      </dl>
      <Progress total={example.totalContributed} goal={example.goal} />
    </article>
  );
}

export function ExampleCampaigns() {
  return (
    <section aria-labelledby="examples-title" className="examples" data-testid="example-campaigns">
      <div className="section-head">
        <h2 id="examples-title">Example Campaigns</h2>
        <p className="muted">Demonstration only · not on-chain</p>
      </div>
      <Notice tone="warn" testId="example-disclaimer">{EXAMPLE_DISCLAIMER}</Notice>
      <div className="grid" data-testid="example-grid">
        {EXAMPLE_CAMPAIGNS.map((e) => (
          <ExampleCard key={e.key} example={e} />
        ))}
      </div>
    </section>
  );
}
