import { useState } from "react";
import { Hero } from "../components/Hero.jsx";
import { ExampleCampaigns } from "../components/ExampleCampaigns.jsx";
import { CampaignCard, Notice, QueryState, SelfFundingNote } from "../components/common.jsx";
import { InsolvencyNotice } from "../components/SolvencyPanel.jsx";
import { PAGE_SIZE } from "../lib/api.js";
import { useChainQuery } from "../state/AppContext.js";

export function HomePage() {
  const [page, setPage] = useState(0);
  const list = useChainQuery((api) => api.getCampaignPage(page, PAGE_SIZE), [page]);
  const solvency = useChainQuery((api) => api.manager.isSolvent(), []);
  const count = list.data?.count ?? 0n;
  const pages = count === 0n ? 1 : Number((count + BigInt(PAGE_SIZE) - 1n) / BigInt(PAGE_SIZE));

  return (
    <>
      <Hero />
      <ExampleCampaigns />
      <section aria-labelledby="campaigns-title" data-testid="live-campaigns">
        <div className="section-head">
          <h2 id="campaigns-title">Live Campaigns</h2>
          {list.data && <p className="muted" data-testid="live-count">{String(count)} campaign(s) recorded on-chain · newest first</p>}
        </div>
        {solvency.data === false && <InsolvencyNotice />}
        <Notice tone="info">
          Phases: <strong>Open</strong> (accepting contributions) · <strong>Awaiting finalization</strong> (deadline
          reached, so anyone may finalize) · <strong>Successful</strong> (goal met, so the creator may claim) · <strong>Failed</strong>{" "}
          (goal missed, so contributors may reclaim 100%).
        </Notice>
        <SelfFundingNote />
        <QueryState state={list} empty={Object.assign((d) => d.campaigns.length === 0, { message: "No campaigns yet. Create the first one." })}>
          {(data) => (
            <>
              <div className="grid" data-testid="campaign-grid">
                {data.campaigns.map((c) => (
                  <CampaignCard key={String(c.id)} campaign={c} now={data.now} />
                ))}
              </div>
              <nav className="pager" aria-label="Campaign pages">
                <button type="button" className="btn btn-small" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Newer</button>
                <span aria-live="polite">Page {page + 1} of {pages}</span>
                <button type="button" className="btn btn-small" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Older</button>
              </nav>
            </>
          )}
        </QueryState>
      </section>
    </>
  );
}
