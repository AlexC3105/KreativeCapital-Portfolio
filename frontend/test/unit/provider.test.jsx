// AppProvider: deployment verification states, wallet connection lifecycle, account and network
// transitions, and write-time revalidation. Uses fake services and a fake EIP-1193 wallet
// (test-only).
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../src/state/AppProvider.jsx";
import { useApp } from "../../src/state/AppContext.js";
import { ALICE, BOB, sampleManifest } from "../helpers/fixtures.js";

afterEach(cleanup);

function fakeWallet({ accounts = [ALICE], rejectConnect = false } = {}) {
  const listeners = {};
  const w = {
    accounts,
    chainOk: true,
    request: vi.fn(async ({ method }) => {
      if (method === "eth_requestAccounts") {
        if (rejectConnect) throw { code: 4001 };
        return w.accounts;
      }
      if (method === "eth_accounts") return w.accounts;
      throw new Error("unexpected " + method);
    }),
    on: (e, fn) => (listeners[e] = fn),
    removeListener: (e) => delete listeners[e],
    emit: (e, arg) => listeners[e]?.(arg),
    listeners,
  };
  return w;
}

function services({ wallet, wallets, verify = { ok: true, stale: false, checks: [] }, manifestError } = {}) {
  return {
    artifacts: { KreativeToken: { abi: [] }, CampaignManager: { abi: [] } },
    loadManifest: async () => {
      if (manifestError) throw manifestError;
      return sampleManifest();
    },
    createReadProvider: () => ({ getBlockNumber: async () => 1, destroy() {} }),
    createBrowserProvider: () => ({ getSigner: async (a) => ({ address: a }) }),
    verifyDeployment: vi.fn(async () => verify),
    verifyWalletChain: vi.fn(async () =>
      wallet?.chainOk ? { ok: true } : { ok: false, code: "wrong-network", reason: "Your wallet is on chain 1." }
    ),
    discoverWallets: async () =>
      wallets ?? (wallet ? [{ info: { uuid: "t", name: "Test wallet" }, provider: wallet }] : []),
    pollMs: 1e9,
    reverifyMs: 1e9,
  };
}

let app;
function Probe() {
  app = useApp();
  return (
    <div>
      <span data-testid="dep">{app.deployment.status}</span>
      <span data-testid="wallet">{app.wallet.status}:{app.wallet.account ?? "-"}:{String(app.wallet.chainOk)}</span>
      <span data-testid="blocked">{app.writeBlockedReason ?? "writes-allowed"}</span>
    </div>
  );
}
const renderWith = (svc) => render(<AppProvider services={svc}><Probe /></AppProvider>);

describe("AppProvider", () => {
  it("verifies the deployment and keeps writes blocked until a wallet connects", async () => {
    renderWith(services());
    await waitFor(() => expect(screen.getByTestId("dep").textContent).toBe("verified"));
    expect(app.api).toBeTruthy();
    expect(screen.getByTestId("blocked").textContent).toMatch(/Connect a wallet/);
  });

  it("reports a stale deployment and disables writes", async () => {
    renderWith(services({ verify: { ok: false, stale: true, checks: [] } }));
    await waitFor(() => expect(screen.getByTestId("dep").textContent).toBe("stale"));
    expect(app.api).toBeNull();
    expect(screen.getByTestId("blocked").textContent).toMatch(/not verified|until the local deployment is verified/);
  });

  it("connects, follows account changes and disconnects", async () => {
    const wallet = fakeWallet();
    renderWith(services({ wallet }));
    await waitFor(() => expect(screen.getByTestId("dep").textContent).toBe("verified"));
    await act(() => app.connect());
    expect(screen.getByTestId("wallet").textContent).toBe(`connected:${ALICE}:true`);
    expect(screen.getByTestId("blocked").textContent).toBe("writes-allowed");

    wallet.accounts = [BOB];
    await act(async () => wallet.emit("accountsChanged", [BOB]));
    expect(screen.getByTestId("wallet").textContent).toBe(`connected:${BOB}:true`);

    await act(async () => wallet.emit("accountsChanged", []));
    expect(screen.getByTestId("wallet").textContent).toMatch(/^disconnected/);

    wallet.accounts = [ALICE];
    await act(() => app.connect());
    act(() => app.disconnect());
    expect(screen.getByTestId("wallet").textContent).toMatch(/^disconnected/);
    expect(wallet.listeners.accountsChanged).toBeUndefined();
  });

  it("disables writes on a network change to an unexpected chain", async () => {
    const wallet = fakeWallet();
    renderWith(services({ wallet }));
    await waitFor(() => expect(screen.getByTestId("dep").textContent).toBe("verified"));
    await act(() => app.connect());
    wallet.chainOk = false;
    await act(async () => wallet.emit("chainChanged", "0x1"));
    expect(screen.getByTestId("wallet").textContent).toBe(`connected:${ALICE}:false`);
    expect(screen.getByTestId("blocked").textContent).toMatch(/chain 1/);
  });

  it("handles a rejected connection request", async () => {
    renderWith(services({ wallet: fakeWallet({ rejectConnect: true }) }));
    await waitFor(() => expect(screen.getByTestId("dep").textContent).toBe("verified"));
    await act(() => app.connect());
    expect(app.wallet).toMatchObject({ status: "disconnected", message: expect.stringMatching(/rejected/) });
  });

  it("revalidates account, chain and deployment immediately before a write", async () => {
    const wallet = fakeWallet();
    const svc = services({ wallet });
    renderWith(svc);
    await waitFor(() => expect(screen.getByTestId("dep").textContent).toBe("verified"));
    await act(() => app.connect());
    const ok = await act(() => app.getWriteContext());
    expect(ok).toMatchObject({ ok: true, account: ALICE, signer: { address: ALICE } });

    // The wallet silently switched accounts (no event yet): the write is refused.
    wallet.accounts = [BOB];
    const changed = await act(() => app.getWriteContext());
    expect(changed).toMatchObject({ ok: false, code: "account-changed", reason: expect.stringMatching(/account or network changed/) });

    // Wallet now on the wrong chain: refused.
    wallet.chainOk = false;
    const wrong = await act(() => app.getWriteContext());
    expect(wrong).toMatchObject({ ok: false, reason: expect.stringMatching(/chain 1/) });

    // Back on the right chain (the wallet emits chainChanged and is re-verified)...
    wallet.chainOk = true;
    await act(async () => wallet.emit("chainChanged", "0x7a69"));
    expect(screen.getByTestId("blocked").textContent).toBe("writes-allowed");
    // ...then the deployment became stale: refused before touching the wallet.
    svc.verifyDeployment.mockResolvedValue({ ok: false, stale: true, checks: [] });
    const stale = await act(() => app.getWriteContext());
    expect(stale).toMatchObject({ ok: false, reason: expect.stringMatching(/not verified/) });
    expect(screen.getByTestId("dep").textContent).toBe("stale");
  });

  it("asks the user to choose when several wallets are announced, and supports cancel and switching", async () => {
    const first = fakeWallet({ accounts: [ALICE] });
    const second = fakeWallet({ accounts: [BOB] });
    const wallets = [
      { info: { uuid: "a", name: "Wallet A", rdns: "a.test" }, provider: first },
      { info: { uuid: "b", name: "Wallet B", rdns: "b.test" }, provider: second },
    ];
    renderWith(services({ wallet: first, wallets }));
    await waitFor(() => expect(screen.getByTestId("dep").textContent).toBe("verified"));

    await act(() => app.connect());
    expect(app.wallet.status).toBe("choosing");
    expect(app.wallet.options.map((o) => o.name)).toEqual(["Wallet A", "Wallet B"]);
    expect(first.request).not.toHaveBeenCalled(); // nothing chosen arbitrarily
    expect(second.request).not.toHaveBeenCalled();

    act(() => app.cancelWalletChoice());
    expect(screen.getByTestId("wallet").textContent).toMatch(/^disconnected/);

    await act(() => app.connect());
    await act(() => app.selectWallet("b"));
    expect(screen.getByTestId("wallet").textContent).toBe(`connected:${BOB}:true`);
    expect(first.request).not.toHaveBeenCalled();
    expect(second.listeners.accountsChanged).toBeTypeOf("function");

    // Switching providers detaches the previous provider's listeners.
    act(() => app.disconnect());
    await act(() => app.connect());
    await act(() => app.selectWallet("a"));
    expect(screen.getByTestId("wallet").textContent).toBe(`connected:${ALICE}:true`);
    expect(second.listeners.accountsChanged).toBeUndefined();
    expect(first.listeners.accountsChanged).toBeTypeOf("function");
    await act(async () => second.emit("accountsChanged", [BOB]));
    expect(screen.getByTestId("wallet").textContent).toBe(`connected:${ALICE}:true`); // old provider ignored
  });

  // FR-01 regressions: account/network changes during asynchronous processing.
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
  };

  it("invalidates writes immediately on an account change and keeps them disabled until the new account is verified", async () => {
    const wallet = fakeWallet();
    const svc = services({ wallet });
    renderWith(svc);
    await waitFor(() => expect(screen.getByTestId("dep").textContent).toBe("verified"));
    await act(() => app.connect());
    expect(screen.getByTestId("blocked").textContent).toBe("writes-allowed");

    const check = deferred();
    svc.verifyWalletChain.mockImplementationOnce(() => check.promise);
    wallet.accounts = [BOB];
    await act(async () => { wallet.emit("accountsChanged", [BOB]); });
    // Shown immediately, but not yet eligible for writes.
    expect(screen.getByTestId("wallet").textContent).toBe(`connected:${BOB}:false`);
    expect(screen.getByTestId("blocked").textContent).toMatch(/Verifying/);
    const during = await act(() => app.getWriteContext());
    expect(during).toMatchObject({ ok: false, code: "context-unverified" });

    await act(async () => check.resolve({ ok: true }));
    expect(screen.getByTestId("wallet").textContent).toBe(`connected:${BOB}:true`);
    const after = await act(() => app.getWriteContext());
    expect(after).toMatchObject({ ok: true, account: BOB });
  });

  it("discards a stale verification result that finishes after a newer wallet context", async () => {
    const wallet = fakeWallet();
    const svc = services({ wallet });
    renderWith(svc);
    await waitFor(() => expect(screen.getByTestId("dep").textContent).toBe("verified"));
    await act(() => app.connect());

    const older = deferred();
    const newer = deferred();
    svc.verifyWalletChain.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    wallet.accounts = [BOB];
    await act(async () => { wallet.emit("accountsChanged", [BOB]); }); // epoch n (older check pending)
    await act(async () => { wallet.emit("chainChanged", "0x1"); }); // epoch n+1 (newer check pending)
    await act(async () => newer.resolve({ ok: false, code: "wrong-network", reason: "Your wallet is on chain 1." }));
    expect(screen.getByTestId("blocked").textContent).toMatch(/chain 1/);
    // The older, successful result arrives late: it must not restore write eligibility.
    await act(async () => older.resolve({ ok: true }));
    expect(screen.getByTestId("wallet").textContent).toBe(`connected:${BOB}:false`);
    expect(screen.getByTestId("blocked").textContent).toMatch(/chain 1/);
    const ctx = await act(() => app.getWriteContext());
    expect(ctx.ok).toBe(false);
  });

  it("refuses an action whose account changes while it is being verified, without carrying it to the new account", async () => {
    const wallet = fakeWallet();
    const svc = services({ wallet });
    renderWith(svc);
    await waitFor(() => expect(screen.getByTestId("dep").textContent).toBe("verified"));
    await act(() => app.connect());

    const slow = deferred();
    svc.verifyDeployment.mockImplementationOnce(() => slow.promise);
    let pending;
    act(() => {
      pending = app.getWriteContext(); // user intent captured for ALICE
    });
    wallet.accounts = [BOB];
    await act(async () => { wallet.emit("accountsChanged", [BOB]); });
    await act(async () => slow.resolve({ ok: true, stale: false, checks: [] }));
    const result = await act(() => pending);
    expect(result).toMatchObject({ ok: false, code: "account-changed" });
    expect(result.signer).toBeUndefined();
  });

  it("re-checks the context immediately before submission (recheck)", async () => {
    const wallet = fakeWallet();
    renderWith(services({ wallet }));
    await waitFor(() => expect(screen.getByTestId("dep").textContent).toBe("verified"));
    await act(() => app.connect());
    const ctx = await act(() => app.getWriteContext());
    expect(ctx).toMatchObject({ ok: true, account: ALICE, chainId: 31337n });
    expect(await ctx.recheck()).toEqual({ ok: true });

    // Silent account switch in the wallet (no event yet).
    wallet.accounts = [BOB];
    expect(await ctx.recheck()).toMatchObject({ ok: false, code: "account-changed" });
    // Account restored, but a wallet event started a new context: still refused.
    wallet.accounts = [ALICE];
    await act(async () => { wallet.emit("chainChanged", "0x7a69"); });
    expect(await ctx.recheck()).toMatchObject({ ok: false, code: "account-changed" });
  });

  it("reports a missing manifest", async () => {
    const err = Object.assign(new Error("No local deployment found."), { code: "missing" });
    Object.setPrototypeOf(err, (await import("../../src/lib/manifest.js")).ManifestError.prototype);
    renderWith(services({ manifestError: err }));
    await waitFor(() => expect(screen.getByTestId("dep").textContent).toBe("missing"));
  });
});

