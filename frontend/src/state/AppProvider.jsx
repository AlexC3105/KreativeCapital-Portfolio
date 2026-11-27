import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserProvider, getAddress, JsonRpcProvider } from "ethers";
import KreativeToken from "../abi/KreativeToken.json";
import CampaignManager from "../abi/CampaignManager.json";
import { loadManifest, ManifestError, EXPECTED_CHAIN_ID } from "../lib/manifest.js";
import { verifyDeployment, verifyWalletChain } from "../lib/verify.js";
import { discoverWallets } from "../lib/wallet.js";
import { createApi } from "../lib/api.js";
import { createActions } from "../lib/actions.js";
import { isUserRejection } from "../lib/errors.js";
import { buildWriteContext } from "../lib/writeContext.js";
import { AppContext } from "./AppContext.js";
import { createTxStore } from "./txStore.js";

export const defaultServices = {
  artifacts: { KreativeToken, CampaignManager },
  loadManifest: () => loadManifest(),
  createReadProvider: (manifest) =>
    new JsonRpcProvider(manifest.rpcUrl, EXPECTED_CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 }),
  createBrowserProvider: (eip1193) => new BrowserProvider(eip1193),
  verifyDeployment,
  verifyWalletChain,
  discoverWallets: () => discoverWallets(),
  pollMs: 3000,
  reverifyMs: 10000,
};

const sameManifest = (a, b) =>
  a && b && a.genesisHash === b.genesisHash && a.rpcUrl === b.rpcUrl &&
  a.contracts.CampaignManager.runtimeCodeHash === b.contracts.CampaignManager.runtimeCodeHash &&
  a.contracts.CampaignManager.address === b.contracts.CampaignManager.address;

export function AppProvider({ children, services = defaultServices }) {
  const [deployment, setDeployment] = useState({ status: "loading" });
  const [core, setCore] = useState({ api: null, actions: null });
  const [wallet, setWallet] = useState({ status: "disconnected" });
  const [refreshKey, setRefreshKey] = useState(0);
  const txStoreRef = useRef(null);
  txStoreRef.current ??= createTxStore();
  // Wallet context model:
  // - `epoch` increases on every wallet event (account change, network change, connect,
  //   disconnect). An increase immediately makes writes ineligible.
  // - `verified` is {account, epoch} only when the account shown in the UI has been verified on
  //   the expected chain instance for the current epoch.
  // - Verification results that finish after a newer epoch began are discarded, so a stale
  //   result can never restore an outdated write context.
  const ref = useRef({ manifest: null, provider: null, entry: null, listeners: null, lastBlock: null, epoch: 0, verified: null });

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  /**
   * Evaluate the wallet's account and network.
   * @param {boolean} contextChanged  true for wallet events: start a new epoch and invalidate
   *   write eligibility at once; false for periodic re-checks of an unchanged context.
   */
  const evaluateWallet = useCallback(
    async (entry, accounts, { contextChanged = true } = {}) => {
      const raw = accounts?.[0];
      const account = raw ? getAddress(raw) : null;
      const current = ref.current.verified;
      if (contextChanged || !current || current.account !== account) {
        ref.current.epoch += 1;
        ref.current.verified = null;
      }
      const epoch = ref.current.epoch;
      if (!account) {
        setWallet({ status: "disconnected", message: "The wallet has no connected account." });
        return;
      }
      if (!ref.current.verified) {
        // Show the new account immediately, but keep writes disabled until it is verified.
        setWallet({ status: "connected", account, name: entry.info?.name ?? "Wallet", chainOk: false, chainCode: "verifying", chainReason: "Verifying the wallet's account and network…" });
      }
      let chain = { ok: false, code: "unverified", reason: "The local deployment is not verified yet." };
      if (ref.current.manifest) {
        try {
          chain = await services.verifyWalletChain(entry.provider, ref.current.manifest);
        } catch {
          chain = { ok: false, code: "check-failed", reason: "Could not verify the wallet's network." };
        }
      }
      if (ref.current.entry !== entry || ref.current.epoch !== epoch) return; // superseded: discard
      ref.current.verified = chain.ok ? { account, epoch } : null;
      setWallet({ status: "connected", account, name: entry.info?.name ?? "Wallet", chainOk: chain.ok, chainCode: chain.code, chainReason: chain.reason });
    },
    [services]
  );

  /** Load the runtime manifest and verify it on-chain. Returns true when verified. */
  const verify = useCallback(async () => {
    let manifest;
    try {
      manifest = await services.loadManifest();
    } catch (e) {
      const status = e instanceof ManifestError ? (e.code === "missing" ? "missing" : e.code === "invalid" ? "invalid" : "unavailable") : "unavailable";
      ref.current.manifest = null;
      setCore({ api: null, actions: null });
      setDeployment({ status, message: e.message });
      return false;
    }
    const changed = !sameManifest(manifest, ref.current.manifest);
    if (changed || !ref.current.provider) {
      ref.current.provider?.destroy?.();
      ref.current.provider = services.createReadProvider(manifest);
    }
    ref.current.manifest = manifest;
    let result;
    try {
      result = await services.verifyDeployment(ref.current.provider, manifest, services.artifacts);
    } catch {
      setCore({ api: null, actions: null });
      setDeployment({ status: "rpc-unavailable", manifest, message: "The local RPC at " + manifest.rpcUrl + " is unavailable." });
      return false;
    }
    if (!result.ok) {
      setCore({ api: null, actions: null });
      setDeployment({ status: result.stale ? "stale" : "unverified", manifest, checks: result.checks });
      return false;
    }
    setDeployment((d) => (d.status === "verified" && !changed ? d : { status: "verified", manifest, checks: result.checks }));
    if (changed || !ref.current.api) {
      const api = createApi({ provider: ref.current.provider, manifest, artifacts: services.artifacts });
      ref.current.api = api;
      setCore({ api, actions: createActions({ api, getWriteContext: () => ref.current.getWriteContext() }) });
    }
    return true;
  }, [services]);

  // Called synchronously when the user starts an action: capture the verified context the UI is
  // showing (account + epoch), then revalidate deployment, wallet account and chain. The action
  // is refused if the context changes at any point before submission; it is never carried over
  // to a different account (fresh user intent is required).
  ref.current.getWriteContext = async () => {
    const intent = ref.current.verified;
    const entry = ref.current.entry;
    const epoch = ref.current.epoch;
    if (!entry) return { ok: false, code: "no-wallet", reason: "Connect a wallet first." };
    if (!intent || intent.epoch !== epoch) {
      return { ok: false, code: "context-unverified", reason: "Your wallet's account or network is still being verified. Wait until it is shown as connected, then try again." };
    }
    const isCurrent = () => ref.current.entry === entry && ref.current.epoch === epoch && ref.current.verified?.account === intent.account;
    const changedResult = { ok: false, code: "account-changed", reason: "Your wallet account or network changed, so this action was not submitted. Review it for the current account and try again." };
    if (!(await verify())) return { ok: false, code: "unverified", reason: "The local deployment is not verified (stale, changed or unavailable). Writes are disabled." };
    if (!isCurrent()) return changedResult;
    const { manifest, provider } = ref.current;
    const result = await buildWriteContext({
      provider,
      manifest,
      artifacts: services.artifacts,
      eip1193: entry.provider,
      expectedAccount: intent.account,
      isCurrent: () => isCurrent() && sameManifest(ref.current.manifest, manifest),
      createBrowserProvider: services.createBrowserProvider,
      verifyDeploymentFn: services.verifyDeployment,
      verifyWalletFn: services.verifyWalletChain,
    });
    if (!result.ok && ["account-changed", "wrong-network", "different-chain", "no-account"].includes(result.code)) {
      await evaluateWallet(entry, await entry.provider.request({ method: "eth_accounts" }).catch(() => []));
    }
    return result;
  };

  useEffect(() => {
    verify();
  }, [verify]);

  // New blocks trigger refreshes; periodic re-verification detects restarted (stale) chains.
  useEffect(() => {
    const poll = setInterval(async () => {
      const provider = ref.current.api ? ref.current.provider : null;
      if (!provider) return;
      try {
        const n = await provider.getBlockNumber();
        if (n !== ref.current.lastBlock) {
          ref.current.lastBlock = n;
          refresh();
        }
      } catch {
        verify();
      }
    }, services.pollMs);
    const reverify = setInterval(async () => {
      await verify();
      if (ref.current.entry) {
        const accounts = await ref.current.entry.provider.request({ method: "eth_accounts" }).catch(() => []);
        evaluateWallet(ref.current.entry, accounts, { contextChanged: false });
      }
    }, services.reverifyMs);
    return () => {
      clearInterval(poll);
      clearInterval(reverify);
    };
  }, [services, verify, refresh, evaluateWallet]);

  const detach = () => {
    const { entry, listeners } = ref.current;
    if (entry && listeners) {
      entry.provider.removeListener?.("accountsChanged", listeners.accounts);
      entry.provider.removeListener?.("chainChanged", listeners.chain);
    }
    ref.current.entry = null;
    ref.current.listeners = null;
    ref.current.epoch += 1;
    ref.current.verified = null;
  };

  const attach = useCallback(
    async (entry) => {
      let accounts;
      try {
        accounts = await entry.provider.request({ method: "eth_requestAccounts" });
      } catch (e) {
        setWallet({ status: "disconnected", message: isUserRejection(e) ? "The connection request was rejected." : "The wallet connection failed." });
        return;
      }
      detach();
      const listeners = {
        accounts: (accs) => evaluateWallet(entry, accs),
        chain: async () => evaluateWallet(entry, await entry.provider.request({ method: "eth_accounts" }).catch(() => [])),
      };
      entry.provider.on?.("accountsChanged", listeners.accounts);
      entry.provider.on?.("chainChanged", listeners.chain);
      ref.current.entry = entry;
      ref.current.listeners = listeners;
      await evaluateWallet(entry, accounts);
    },
    [evaluateWallet]
  );

  const connect = useCallback(async () => {
    setWallet({ status: "connecting" });
    const wallets = await services.discoverWallets();
    if (wallets.length === 0) {
      setWallet({ status: "unavailable", message: "No browser wallet detected. Install an EIP-1193 wallet and add a disposable local development account." });
      return;
    }
    if (wallets.length > 1) {
      // Never pick arbitrarily between several announced wallets: ask the user.
      ref.current.choices = wallets;
      setWallet({ status: "choosing", options: wallets.map((w) => ({ id: w.info.uuid, name: w.info.name, rdns: w.info.rdns })) });
      return;
    }
    await attach(wallets[0]);
  }, [services, attach]);

  const selectWallet = useCallback(
    async (id) => {
      const entry = ref.current.choices?.find((w) => w.info.uuid === id);
      ref.current.choices = null;
      if (!entry) {
        setWallet({ status: "disconnected", message: "That wallet is no longer available." });
        return;
      }
      setWallet({ status: "connecting" });
      await attach(entry);
    },
    [attach]
  );

  const cancelWalletChoice = useCallback(() => {
    ref.current.choices = null;
    setWallet({ status: "disconnected" });
  }, []);

  const disconnect = useCallback(() => {
    detach();
    setWallet({ status: "disconnected" });
  }, []);

  // Re-check the wallet chain whenever the verified deployment changes.
  useEffect(() => {
    if (ref.current.entry && deployment.status === "verified") {
      const entry = ref.current.entry;
      entry.provider.request({ method: "eth_accounts" }).then((a) => evaluateWallet(entry, a, { contextChanged: true })).catch(() => {});
    }
  }, [deployment.status, deployment.manifest, evaluateWallet]);

  const writeBlockedReason = useMemo(() => {
    if (deployment.status !== "verified") return "Writes are disabled until the local deployment is verified.";
    if (wallet.status !== "connected") return "Connect a wallet to make changes.";
    if (!wallet.chainOk) return wallet.chainReason ?? "Your wallet is not on the verified local chain.";
    return null;
  }, [deployment.status, wallet]);

  const getWriteContext = useCallback(() => ref.current.getWriteContext(), []);
  const value = { deployment, wallet, api: core.api, actions: core.actions, txStore: txStoreRef.current, refreshKey, refresh, connect, disconnect, writeBlockedReason, reverify: verify, getWriteContext, selectWallet, cancelWalletChoice };
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
