// UI tests with a fake app context (test-only). They cover the application shell, workflow rules, eligibility, insolvency
// restrictions, owner controls, transaction-state display and the no-WebGL fallback.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App.jsx";
import { AppContext } from "../../src/state/AppContext.js";
import { TxState } from "../../src/lib/tx.js";
import { EXAMPLE_CAMPAIGNS, EXAMPLE_DISCLAIMER } from "../../src/lib/examples.js";
import { ALICE, BOB, KT, OWNER, campaign, fakeAppValue } from "../helpers/fixtures.js";

// The 3D scene module is replaced so that the WebGL-failure path can be exercised in jsdom.
vi.mock("../../src/components/HeroScene.jsx", () => ({
  default: () => {
    throw new Error("WebGL renderer failed");
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const connected = (account, extra = {}) => ({ wallet: { status: "connected", account, chainOk: true }, writeBlockedReason: null, ...extra });

function renderApp(route, overrides = {}) {
  const value = fakeAppValue(overrides);
  render(
    <AppContext.Provider value={value}>
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </AppContext.Provider>
  );
  return value;
}

/** Fake action that reports a terminal record through onUpdate (no chain access). */
const actionResult = (record) => vi.fn(async (...args) => {
  const onUpdate = args[args.length - 1];
  onUpdate(record);
  return record;
});

describe("application shell", () => {
  it("renders navigation, the campaign list and the local-development disclosure", async () => {
    renderApp("/");
    for (const label of ["Campaigns", "Create campaign", "Get KT", "My account", "Transparency"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByText(/KT has no value, no redemption rights and no backing/)).toBeInTheDocument();
    expect(await screen.findByTestId("campaign-card-1")).toHaveTextContent("Solar Garden");
    expect(screen.getByText(/does not\s+prove independent third-party demand/)).toBeInTheDocument();
  });

  it("renders the create-campaign route with its form", () => {
    renderApp("/create");
    expect(screen.getByRole("heading", { name: "Create a campaign" })).toBeInTheDocument();
    expect(screen.getByTestId("create-button")).toBeDisabled();
  });

  it("shows empty, unavailable and error states for campaign discovery", async () => {
    renderApp("/", { api: { getCampaignPage: async () => ({ campaigns: [], count: 0n, now: 1n }) } });
    expect(await screen.findByTestId("empty-state")).toHaveTextContent("No campaigns yet");
    cleanup();
    renderApp("/", { value: { api: null } });
    expect(await screen.findByTestId("data-unavailable")).toBeInTheDocument();
    cleanup();
    renderApp("/", { api: { getCampaignPage: async () => { throw new Error("connection refused"); } } });
    expect(await screen.findByTestId("data-error")).toHaveTextContent("connection refused");
  });

  it("labels all four lifecycle phases distinctly", async () => {
    const campaigns = [0, 1, 2, 3].map((phase) => campaign({ id: BigInt(phase + 1), phase, status: phase >= 2 ? phase - 1 : 0 }));
    renderApp("/", { api: { getCampaignPage: async () => ({ campaigns, count: 4n, now: 1n }) } });
    await screen.findByTestId("campaign-card-1");
    for (const label of ["Open", "Awaiting finalization", "Successful", "Failed"]) {
      expect(within(screen.getByTestId("campaign-grid")).getAllByText(label, { selector: ".badge" }).length).toBe(1);
    }
  });
});

describe("deployment and network banners", () => {
  it("warns about a stale deployment", () => {
    renderApp("/", { value: { deployment: { status: "stale", manifest: null }, api: null } });
    expect(screen.getByTestId("deployment-banner")).toHaveTextContent(/Stale deployment manifest/);
  });
  it("warns about the wrong network", () => {
    renderApp("/", { value: { wallet: { status: "connected", account: ALICE, chainOk: false, chainReason: "Your wallet is on chain 1." }, writeBlockedReason: "Your wallet is on chain 1." } });
    expect(screen.getByTestId("network-banner")).toHaveTextContent(/chain 1/);
  });
});

describe("campaign creation", () => {
  const fill = (id, v) => fireEvent.change(screen.getByTestId(id), { target: { value: v } });

  it("enforces UTF-8 byte limits, goal and duration bounds", async () => {
    renderApp("/create", { value: connected(ALICE) });
    fill("name-input", "😀".repeat(16) + "a"); // 65 bytes, 17 characters
    expect(await screen.findByText(/65 UTF-8 bytes, but the maximum is 64/)).toBeInTheDocument();
    fill("name-input", "😀".repeat(16));
    fill("description-input", "é".repeat(251));
    expect(screen.getByText(/502 UTF-8 bytes, but the maximum is 500/)).toBeInTheDocument();
    fill("description-input", "ok");
    fill("goal-input", "1000000.000000000000000001");
    expect(screen.getByText(/cannot exceed the total supply/)).toBeInTheDocument();
    fill("goal-input", "0");
    expect(screen.getByText(/greater than zero/)).toBeInTheDocument();
    fill("goal-input", "250.5");
    fill("days-input", "0");
    expect(screen.getByText(/at least 60 seconds/)).toBeInTheDocument();
    fill("days-input", "366");
    expect(screen.getByText(/at most 365 days/)).toBeInTheDocument();
    fill("days-input", "0");
    fill("minutes-input", "1");
    expect(screen.getByTestId("create-button")).toBeEnabled();
  });

  it("submits exact base units and links the verified campaign id", async () => {
    const createCampaign = actionResult({ label: "Create campaign", state: TxState.CONFIRMED, result: { id: 7n } });
    renderApp("/create", { value: { ...connected(ALICE), actions: { createCampaign } } });
    fill("name-input", "Garden");
    fill("goal-input", "0.000000000000000123");
    fill("days-input", "1");
    fill("hours-input", "2");
    fill("minutes-input", "3");
    fireEvent.click(screen.getByTestId("create-button"));
    await screen.findByTestId("created-link");
    expect(createCampaign.mock.calls[0][0]).toEqual({ goal: 123n, duration: 86400n + 7200n + 180n, name: "Garden", description: "" });
    expect(screen.getByRole("link", { name: "#7" })).toHaveAttribute("href", "/campaigns/7");
  });

  it("keeps submission disabled while writes are blocked", () => {
    renderApp("/create", { value: { writeBlockedReason: "Writes are disabled until the local deployment is verified." } });
    expect(screen.getByText(/until the local deployment is verified/)).toBeInTheDocument();
    expect(screen.getByTestId("create-button")).toBeDisabled();
  });
});

describe("token acquisition", () => {
  const fill = (v) => fireEvent.change(screen.getByTestId("eth-input"), { target: { value: v } });

  it("previews exact KT and validates ETH balance and reserve", async () => {
    renderApp("/tokens", { value: connected(BOB), api: { provider: { getBalance: async () => KT(2) }, token: { saleReserve: async () => KT(150), balanceOf: async () => 0n } } });
    await screen.findByTestId("reserve");
    fill("0.000000000000000001");
    expect(screen.getByTestId("kt-preview")).toHaveTextContent("exactly 0.0000000000000001 KT");
    fill("1.5000000000000001");
    expect(screen.getByText(/Only 150 KT remain/)).toBeInTheDocument();
    fill("1.4");
    expect(screen.getByTestId("buy-button")).toBeEnabled();
    fill("2.0000000000000001");
    expect(screen.getByText(/ETH balance \(2 ETH\) is too low|Only 150 KT remain/)).toBeInTheDocument();
  });

  it("passes exact wei and shows a wallet rejection without claiming success", async () => {
    const buyTokens = actionResult({ label: "Buy KT", state: TxState.REJECTED, message: "You rejected the request in your wallet. Nothing was submitted." });
    renderApp("/tokens", { value: { ...connected(BOB), actions: { buyTokens } } });
    await screen.findByTestId("reserve");
    fill("0.25");
    fireEvent.click(screen.getByTestId("buy-button"));
    const status = await screen.findByTestId("tx-status");
    expect(buyTokens.mock.calls[0][0]).toBe(250000000000000000n);
    expect(status).toHaveAttribute("data-state", "rejected");
    expect(status).toHaveTextContent("Rejected in wallet");
    expect(status).not.toHaveTextContent("Confirmed");
  });
});

describe("contributions and allowance", () => {
  const detail = (me, extra = {}) => ({
    getCampaign: async (id) => ({ campaign: campaign({ id: BigInt(id), ...extra }), me, now: 2000n }),
  });
  const fill = (v) => fireEvent.change(screen.getByTestId("contribution-input"), { target: { value: v } });

  it("requires an exact approval before contributing", async () => {
    const approve = actionResult({ label: "Approve KT allowance", state: TxState.CONFIRMED });
    renderApp("/campaigns/1", { value: { ...connected(BOB), actions: { approve } }, api: detail({ contribution: 0n, refunded: false, balance: KT(50), allowance: 0n }) });
    await screen.findByTestId("campaign-detail");
    fill("12.5");
    expect(screen.getByTestId("approve-button")).toHaveTextContent("Approve exactly 12.5 KT");
    fireEvent.click(screen.getByTestId("approve-button"));
    await waitFor(() => expect(approve).toHaveBeenCalled());
    expect(approve.mock.calls[0][0]).toBe(12500000000000000000n);
  });

  it("contributes when the allowance covers the amount and rejects amounts above the balance", async () => {
    const contribute = actionResult({ label: "Contribute to campaign #1", state: TxState.CONFIRMED });
    renderApp("/campaigns/1", { value: { ...connected(BOB), actions: { contribute } }, api: detail({ contribution: 0n, refunded: false, balance: KT(50), allowance: KT(20) }) });
    await screen.findByTestId("campaign-detail");
    fill("60");
    expect(screen.getByText(/balance \(50 KT\) is too low/)).toBeInTheDocument();
    fill("20");
    fireEvent.click(screen.getByTestId("contribute-button"));
    await waitFor(() => expect(contribute).toHaveBeenCalledWith(1n, KT(20), expect.any(Function)));
  });

  it("discloses the remaining allowance and offers revocation after a failed contribution", async () => {
    const contribute = actionResult({ label: "Contribute to campaign #1", state: TxState.REVERTED, message: "Mined but reverted. No state changed." });
    renderApp("/campaigns/1", { value: { ...connected(BOB), actions: { contribute, approve: vi.fn() } }, api: detail({ contribution: 0n, refunded: false, balance: KT(50), allowance: KT(20) }) });
    await screen.findByTestId("campaign-detail");
    fill("20");
    fireEvent.click(screen.getByTestId("contribute-button"));
    const notice = await screen.findByTestId("remaining-allowance");
    expect(notice).toHaveTextContent("allowance of 20 KT");
    expect(screen.getByRole("button", { name: "Revoke allowance" })).toBeEnabled();
  });

  it("disables contributions and claims while insolvent, keeping finalization available", async () => {
    renderApp("/campaigns/1", { value: connected(BOB), solvent: false, api: { manager: { isSolvent: async () => false }, ...detail({ contribution: 0n, refunded: false, balance: KT(50), allowance: KT(50) }) } });
    await screen.findByTestId("campaign-detail");
    expect(screen.getAllByTestId("insolvency-notice").length).toBeGreaterThan(0);
    expect(screen.getByTestId("contribute-blocked")).toHaveTextContent(/solvency rule/);
    expect(screen.getByTestId("contribute-button")).toBeDisabled();
    cleanup();
    renderApp("/campaigns/1", { value: connected(BOB), api: { manager: { isSolvent: async () => false }, ...detail(null, { phase: 1 }) } });
    expect(await screen.findByTestId("finalize-button")).toBeEnabled();
  });
});

describe("finalization and settlement eligibility", () => {
  const show = async (account, campaignOverrides, me = null) => {
    renderApp("/campaigns/1", {
      value: connected(account),
      api: { getCampaign: async () => ({ campaign: campaign(campaignOverrides), me, now: 9000n }) },
    });
    await screen.findByTestId("campaign-detail");
  };
  it("offers finalization to anyone after the deadline", async () => {
    await show(BOB, { phase: 1 });
    expect(screen.getByTestId("finalize-button")).toBeEnabled();
  });
  it("offers the creator payout only to the creator, once", async () => {
    await show(ALICE, { phase: 2, status: 1, platformFee: KT(1), creatorEntitlement: KT(99) });
    expect(screen.getByTestId("claim-payout-button")).toHaveTextContent("Claim 99 KT");
    cleanup();
    await show(BOB, { phase: 2, status: 1, creatorEntitlement: KT(99) });
    expect(screen.queryByTestId("claim-payout-button")).toBeNull();
    expect(screen.getByText("Only the creator can claim the payout.")).toBeInTheDocument();
    cleanup();
    await show(ALICE, { phase: 2, status: 1, creatorPaid: true });
    expect(screen.getByTestId("payout-claimed")).toBeInTheDocument();
  });
  it("offers full refunds only to contributors of failed campaigns, once", async () => {
    await show(BOB, { phase: 3, status: 2 }, { contribution: KT(40), refunded: false, balance: 0n, allowance: 0n });
    expect(screen.getByTestId("claim-refund-button")).toHaveTextContent("Reclaim 40 KT");
    cleanup();
    await show(BOB, { phase: 3, status: 2 }, { contribution: KT(40), refunded: true, balance: 0n, allowance: 0n });
    expect(screen.getByTestId("refund-claimed")).toBeInTheDocument();
    cleanup();
    await show(OWNER, { phase: 3, status: 2 }, { contribution: 0n, refunded: false, balance: 0n, allowance: 0n });
    expect(screen.getByText(/no recorded contribution/)).toBeInTheDocument();
  });
});

describe("account and owner controls", () => {
  it("shows owner functions only for the verified on-chain owner", async () => {
    renderApp("/account", { value: connected(OWNER) });
    expect(await screen.findByTestId("claim-fees-button")).toBeEnabled();
    expect(screen.getByTestId("withdraw-proceeds-button")).toBeEnabled();
    cleanup();
    renderApp("/account", { value: connected(BOB) });
    expect(await screen.findByTestId("not-manager-owner")).toBeInTheDocument();
    expect(screen.getByTestId("not-token-owner")).toBeInTheDocument();
    expect(screen.queryByTestId("claim-fees-button")).toBeNull();
  });
  it("asks for a wallet when disconnected", () => {
    renderApp("/account");
    expect(screen.getByText(/Connect a wallet to see balances/)).toBeInTheDocument();
  });
});

describe("transparency and transaction states", () => {
  it("shows verification checks, solvency figures and the unsolicited-transfer warning", async () => {
    renderApp("/transparency", { solvent: false });
    expect(screen.getByTestId("verification")).toHaveTextContent("Read RPC reports chain id 31337");
    expect(await screen.findByTestId("sp-status")).toHaveTextContent("INSOLVENT");
    expect(screen.getByTestId("sp-liabilities")).toHaveTextContent("40 KT");
    expect(screen.getByText(/Do not send KT directly to the contracts/)).toBeInTheDocument();
  });

  it.each([
    [TxState.AWAITING_WALLET, "Awaiting approval in your wallet"],
    [TxState.SUBMITTED, "Submitted"],
    [TxState.PENDING, "Pending confirmation"],
    [TxState.REVERTED, "Reverted"],
    [TxState.UNKNOWN, "confirmation uncertain"],
    [TxState.CONFIRMED, "Confirmed and verified"],
  ])("renders the %s state distinctly", async (state, text) => {
    const buyTokens = actionResult({ label: "Buy KT", state, from: BOB, hash: "0x" + "ab".repeat(32) });
    renderApp("/tokens", { value: { ...connected(BOB), actions: { buyTokens } } });
    await screen.findByTestId("reserve");
    fireEvent.change(screen.getByTestId("eth-input"), { target: { value: "1" } });
    fireEvent.click(screen.getByTestId("buy-button"));
    const status = await screen.findByTestId("tx-status");
    expect(status).toHaveAttribute("data-state", state);
    expect(status).toHaveTextContent(text);
  });
});

describe("example campaigns (presentation only)", () => {
  const examples = () => within(screen.getByTestId("example-campaigns"));

  it("render three labelled examples without a connected wallet", () => {
    renderApp("/");
    expect(screen.getByRole("heading", { name: "Example Campaigns" })).toBeInTheDocument();
    expect(screen.getByTestId("example-disclaimer")).toHaveTextContent(EXAMPLE_DISCLAIMER);
    const cards = examples().getAllByRole("article");
    expect(cards).toHaveLength(3);
    for (const card of cards) expect(within(card).getByText("Example")).toBeInTheDocument();
    // An active, a successful and a failed (refund-eligible) example.
    expect(examples().getByText("Open")).toBeInTheDocument();
    expect(examples().getByText("Successful")).toBeInTheDocument();
    expect(examples().getByText("Failed")).toBeInTheDocument();
    expect(examples().getByText(/may reclaim 100%/)).toBeInTheDocument();
  });

  it("remain available when the chain is unavailable or erroring, while the live section keeps its own state", async () => {
    renderApp("/", { value: { api: null, deployment: { status: "rpc-unavailable", message: "down" } } });
    expect(examples().getAllByRole("article")).toHaveLength(3);
    expect(await screen.findByTestId("data-unavailable")).toBeInTheDocument();
    cleanup();
    renderApp("/", { api: { getCampaignPage: async () => { throw new Error("connection refused"); } } });
    expect(examples().getAllByRole("article")).toHaveLength(3);
    expect(await screen.findByTestId("data-error")).toHaveTextContent("connection refused");
    cleanup();
    renderApp("/", { api: { getCampaignPage: async () => ({ campaigns: [], count: 0n, now: 1n }) } });
    expect(await screen.findByTestId("empty-state")).toHaveTextContent("No campaigns yet");
    expect(screen.getByTestId("live-count")).toHaveTextContent("0 campaign(s) recorded on-chain"); // examples not counted
    expect(examples().getAllByRole("article")).toHaveLength(3);
  });

  it("expose no financial actions, links or inputs", () => {
    renderApp("/", { value: connected(BOB) });
    const section = screen.getByTestId("example-campaigns");
    expect(section.querySelectorAll("button, a, input, textarea, select, form")).toHaveLength(0);
  });

  it("never enter live counts or the live grid; on-chain cards stay distinguishable", async () => {
    renderApp("/");
    const live = await screen.findByTestId("campaign-card-1");
    expect(screen.getByTestId("live-count")).toHaveTextContent("1 campaign(s) recorded on-chain");
    const grid = screen.getByTestId("campaign-grid");
    expect(within(grid).getAllByRole("article")).toHaveLength(1);
    expect(within(grid).queryByText("Example")).toBeNull();
    expect(within(live).getByRole("link")).toHaveAttribute("href", "/campaigns/1");
    expect(screen.getByTestId("example-grid").contains(live)).toBe(false);
  });

  it("are static data that no chain-facing module imports", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const lib = path.resolve(__dirname, "../../src/lib");
    for (const f of ["api.js", "actions.js", "tx.js", "verify.js", "writeContext.js", "manifest.js"]) {
      expect(fs.readFileSync(path.join(lib, f), "utf8"), f).not.toMatch(/examples/);
    }
    for (const e of EXAMPLE_CAMPAIGNS) {
      expect(typeof e.key).toBe("string"); // never an on-chain campaign id
      expect(e).not.toHaveProperty("id");
      expect(JSON.stringify(e, (k, v) => (typeof v === "bigint" ? String(v) : v))).not.toMatch(/0x[0-9a-fA-F]{40}/);
    }
  });
});

describe("presentation: rendered copy has no em dashes or semicolons", () => {
  // Application copy only: the fixtures contain no externally controlled text with such
  // punctuation (wallet names, campaign names and descriptions are user or wallet supplied).
  const PROHIBITED = /[;\u2014]/;
  const cases = [
    ["/", {}],
    ["/", { value: { api: null, deployment: { status: "rpc-unavailable", message: "The local RPC is unavailable." } } }],
    ["/create", { value: connected(ALICE) }],
    ["/tokens", { value: connected(BOB) }],
    ["/account", { value: connected(OWNER) }],
    ["/transparency", { solvent: false }],
    ["/campaigns/1", { value: connected(BOB), api: { manager: { isSolvent: async () => false } } }],
  ];
  it.each(cases)("%s renders without prohibited punctuation", async (route, overrides) => {
    renderApp(route, overrides);
    await new Promise((r) => setTimeout(r, 30)); // let chain queries resolve
    const text = document.body.textContent;
    expect(text.length).toBeGreaterThan(100);
    expect(text).not.toMatch(PROHIBITED);
  });

  it("transaction states and the unresolved-transaction controls render without prohibited punctuation", async () => {
    for (const state of Object.values(TxState)) {
      const buyTokens = actionResult({ label: "Buy KT", state, from: BOB, hash: "0x" + "ab".repeat(32), message: undefined });
      renderApp("/tokens", { value: { ...connected(BOB), actions: { buyTokens, checkTransaction: vi.fn() } } });
      await screen.findByTestId("reserve");
      fireEvent.change(screen.getByTestId("eth-input"), { target: { value: "1" } });
      fireEvent.click(screen.getByTestId("buy-button"));
      await screen.findByTestId("tx-status");
      expect(document.body.textContent, state).not.toMatch(PROHIBITED);
      cleanup();
    }
  });
});

describe("unresolved (UNKNOWN) transactions", () => {
  const HASH = "0x" + "cd".repeat(32);
  const unknown = (extra = {}) => ({ label: "Buy KT", state: TxState.UNKNOWN, from: BOB, hash: HASH, evidence: "not-found", message: "outcome is uncertain", ...extra });
  const buyOnce = async () => {
    fireEvent.change(await screen.findByTestId("eth-input"), { target: { value: "1" } });
    fireEvent.click(screen.getByTestId("buy-button"));
  };
  const start = async (record, value = {}) => {
    const buyTokens = actionResult(record);
    renderApp("/tokens", { value: { ...connected(BOB), actions: { buyTokens }, ...value } });
    await screen.findByTestId("reserve");
    await buyOnce();
    await screen.findByTestId("tx-unresolved");
    return buyTokens;
  };
  const goHomeAndBack = async () => {
    fireEvent.click(screen.getByRole("link", { name: "Campaigns" }));
    await screen.findByTestId("example-campaigns");
    expect(screen.queryByTestId("buy-button")).toBeNull(); // the Get KT page is unmounted
    fireEvent.click(screen.getByRole("link", { name: "Get KT" }));
    await screen.findByTestId("reserve");
  };

  it("keeps the pause across navigation and remount, so the purchase cannot be resubmitted (TR-01)", async () => {
    const buyTokens = await start(unknown({ resolve: vi.fn(async () => ({ state: TxState.UNKNOWN, evidence: "not-found", message: "Still no receipt" })) }));
    expect(screen.getByTestId("buy-button")).toBeDisabled();
    await goHomeAndBack();
    expect(screen.getByTestId("tx-unresolved")).toBeInTheDocument();
    expect(screen.getByTestId("tx-status")).toHaveTextContent("Unknown: confirmation uncertain");
    expect(screen.getByTestId("buy-button")).toBeDisabled();
    fireEvent.change(screen.getByTestId("eth-input"), { target: { value: "1" } });
    fireEvent.click(screen.getByTestId("buy-button"));
    expect(buyTokens).toHaveBeenCalledTimes(1); // no duplicate, no automatic retry
  });

  it("keeps the pending guard across navigation, and an operation finishing after unmount still updates the section (TR-01)", async () => {
    let finish;
    const buyTokens = vi.fn((wei, onUpdate) => {
      onUpdate({ label: "Buy KT", state: TxState.PENDING, from: BOB, hash: HASH });
      return new Promise((r) => (finish = () => {
        const rec = { label: "Buy KT", state: TxState.CONFIRMED, from: BOB, hash: HASH, message: "Confirmed on-chain and verified against contract state." };
        onUpdate(rec);
        r(rec);
      }));
    });
    renderApp("/tokens", { value: { ...connected(BOB), actions: { buyTokens } } });
    await screen.findByTestId("reserve");
    await buyOnce();
    await goHomeAndBack();
    expect(screen.getByTestId("buy-button")).toBeDisabled(); // still pending after remount
    fireEvent.change(screen.getByTestId("eth-input"), { target: { value: "1" } });
    fireEvent.click(screen.getByTestId("buy-button"));
    expect(buyTokens).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("link", { name: "Campaigns" }));
    await screen.findByTestId("example-campaigns");
    finish(); // completes while the page is unmounted
    fireEvent.click(screen.getByRole("link", { name: "Get KT" }));
    await waitFor(() => expect(screen.getByTestId("tx-status")).toHaveAttribute("data-state", TxState.CONFIRMED));
    fireEvent.change(screen.getByTestId("eth-input"), { target: { value: "1" } }); // the form remounted empty
    await waitFor(() => expect(screen.getByTestId("buy-button")).not.toBeDisabled());
  });

  it("offers no status check after a detected mismatch, and acknowledgement is not proof of success (TR-02)", async () => {
    await start(unknown({ evidence: "mismatch", blockNumber: 3, message: "The returned transaction was mined before this action was submitted. Not counted as success or failure." }));
    expect(screen.queryByTestId("tx-check-status")).toBeNull();
    expect(screen.getByTestId("buy-button")).toBeDisabled();
    fireEvent.click(screen.getByTestId("tx-acknowledge"));
    await waitFor(() => expect(screen.getByTestId("buy-button")).not.toBeDisabled());
    expect(screen.getByTestId("tx-status")).toHaveTextContent(/not proof that the transaction succeeded/);
    expect(screen.getByTestId("tx-status")).toHaveAttribute("data-state", TxState.UNKNOWN);
  });

  it("status check: not found keeps the pause, a mismatch removes the check and keeps the pause (TR-02)", async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({ state: TxState.UNKNOWN, evidence: "not-found", message: "Still no receipt for this hash on the local node." })
      .mockResolvedValueOnce({ state: TxState.UNKNOWN, evidence: "mismatch", blockNumber: 4, message: "The mined transaction was sent by a different account than the one that started this action. Not counted as success or failure." });
    await start(unknown({ resolve }));
    fireEvent.click(screen.getByTestId("tx-check-status"));
    await waitFor(() => expect(screen.getByTestId("tx-status")).toHaveTextContent(/Still no receipt/));
    expect(screen.getByTestId("buy-button")).toBeDisabled();
    fireEvent.click(screen.getByTestId("tx-check-status"));
    await waitFor(() => expect(screen.getByTestId("tx-status")).toHaveTextContent(/different account/));
    expect(screen.queryByTestId("tx-check-status")).toBeNull(); // no path around a detected mismatch
    expect(screen.getByTestId("buy-button")).toBeDisabled();
    expect(screen.getByTestId("tx-status")).toHaveAttribute("data-state", TxState.UNKNOWN);
  });

  it("status check: a verified late receipt confirms and unlocks; a reverted one reports REVERTED (TR-02)", async () => {
    const resolve = vi.fn(async () => ({ state: TxState.CONFIRMED, evidence: "verified", blockNumber: 9, message: "Confirmed and verified after the status check." }));
    await start(unknown({ resolve }));
    fireEvent.click(screen.getByTestId("tx-check-status"));
    await waitFor(() => expect(screen.getByTestId("tx-status")).toHaveAttribute("data-state", TxState.CONFIRMED));
    await waitFor(() => expect(screen.getByTestId("buy-button")).not.toBeDisabled());
    cleanup();
    await start(unknown({ resolve: vi.fn(async () => ({ state: TxState.REVERTED, evidence: "reverted", blockNumber: 9, message: "Mined but reverted. No state changed." })) }));
    fireEvent.click(screen.getByTestId("tx-check-status"));
    await waitFor(() => expect(screen.getByTestId("tx-status")).toHaveAttribute("data-state", TxState.REVERTED));
  });

  it("without a hash, requires explicit acknowledgement before a new attempt", async () => {
    await start(unknown({ hash: undefined, evidence: "no-hash", message: "No transaction hash was returned." }));
    expect(screen.queryByTestId("tx-check-status")).toBeNull();
    expect(screen.getByTestId("buy-button")).toBeDisabled();
    fireEvent.click(screen.getByTestId("tx-acknowledge"));
    await waitFor(() => expect(screen.getByTestId("buy-button")).not.toBeDisabled());
    expect(screen.getByTestId("tx-status")).toHaveTextContent(/still uncertain/);
  });
});

describe("wallet picker and duplicate submissions", () => {
  it("renders an accessible wallet picker with names and cancel", () => {
    const selectWallet = vi.fn();
    const cancelWalletChoice = vi.fn();
    renderApp("/", { value: { wallet: { status: "choosing", options: [{ id: "a", name: "Wallet A", rdns: "a.test" }, { id: "b", name: "Wallet B", rdns: "b.test" }] }, selectWallet, cancelWalletChoice } });
    const dialog = screen.getByRole("dialog", { name: "Choose a wallet" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("wallet-option-0")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Wallet B" }));
    expect(selectWallet).toHaveBeenCalledWith("b");
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(screen.getByTestId("wallet-picker-cancel"));
    expect(cancelWalletChoice).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("connect-wallet")).toBeDisabled();
  });

  it("submits only once when the action button is clicked repeatedly", async () => {
    let finish;
    const buyTokens = vi.fn((wei, onUpdate) => new Promise((resolve) => {
      onUpdate({ label: "Buy KT", state: TxState.PENDING });
      finish = () => { const r = { label: "Buy KT", state: TxState.CONFIRMED }; onUpdate(r); resolve(r); };
    }));
    renderApp("/tokens", { value: { ...connected(BOB), actions: { buyTokens } } });
    await screen.findByTestId("reserve");
    fireEvent.change(screen.getByTestId("eth-input"), { target: { value: "1" } });
    const button = screen.getByTestId("buy-button");
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(buyTokens).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(screen.getByTestId("tx-status")).toHaveAttribute("data-state", "confirmed"));
  });
});

describe("account claim lists", () => {
  it("offers payout, refund and allowance revocation from the account view", async () => {
    const claimCreatorPayout = actionResult({ label: "Claim creator payout (#3)", state: TxState.CONFIRMED });
    const claimRefund = actionResult({ label: "Claim refund (#4)", state: TxState.CONFIRMED });
    const approve = actionResult({ label: "Revoke KT allowance", state: TxState.CONFIRMED });
    const won = campaign({ id: 3n, status: 1, phase: 2, creator: BOB, creatorEntitlement: KT(99) });
    const paid = campaign({ id: 5n, status: 1, phase: 2, creator: BOB, creatorPaid: true });
    const lost = campaign({ id: 4n, status: 2, phase: 3 });
    renderApp("/account", {
      value: { ...connected(BOB), actions: { claimCreatorPayout, claimRefund, approve } },
      api: {
        getAccount: async (account) => ({
          account, eth: KT(1), kt: KT(2), allowance: KT(7), now: 1n, created: [won, paid],
          contributions: [{ campaign: lost, amount: KT(30), refunded: false }, { campaign: won, amount: KT(5), refunded: false }],
          payouts: [won], refunds: [], isManagerOwner: false, isTokenOwner: false, platformFeesOutstanding: 0n, unwithdrawnProceeds: 0n,
        }),
      },
    });
    expect(await screen.findByTestId("acct-allowance")).toHaveTextContent("7 KT");
    expect(screen.getByText(/payout claimed/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("payout-3"));
    await waitFor(() => expect(claimCreatorPayout).toHaveBeenCalledWith(3n, expect.any(Function)));
    fireEvent.click(screen.getByTestId("refund-4"));
    await waitFor(() => expect(claimRefund).toHaveBeenCalledWith(4n, expect.any(Function)));
    expect(screen.queryByTestId("refund-3")).toBeNull(); // successful campaign: no refund
    fireEvent.click(screen.getByTestId("revoke-button"));
    await waitFor(() => expect(approve).toHaveBeenCalledWith(0n, expect.any(Function)));
  });

  it("pages through campaigns newest first", async () => {
    const getCampaignPage = vi.fn(async (page) => ({ campaigns: [campaign({ id: BigInt(13 - page * 6), name: `page ${page}` })], count: 13n, now: 1n }));
    renderApp("/", { api: { getCampaignPage } });
    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Newer" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Older" }));
    expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
    await waitFor(() => expect(getCampaignPage).toHaveBeenLastCalledWith(1, 6));
  });
});

describe("hero without WebGL", () => {
  it("renders the static fallback when WebGL is unavailable (jsdom)", () => {
    renderApp("/");
    expect(screen.getByTestId("hero-static")).toBeInTheDocument();
    expect(screen.queryByTestId("hero-3d")).toBeNull();
  });

  it("falls back to the static hero when the 3D renderer throws, without breaking the app", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({}); // pretend WebGL exists
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderApp("/");
    // The Suspense fallback is itself a static hero; the error boundary then replaces it, so
    // re-query inside waitFor instead of holding the first element.
    expect(await screen.findByTestId("campaign-card-1")).toBeInTheDocument(); // rest of the app still renders
    await waitFor(() => expect(screen.getByTestId("hero-static")).toBeInTheDocument());
    expect(screen.queryByTestId("hero-3d")).toBeNull();
  });

  it("uses the static hero when the user prefers reduced motion", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({});
    const original = window.matchMedia;
    window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    try {
      renderApp("/");
      expect(screen.getByTestId("hero-static")).toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });
});
