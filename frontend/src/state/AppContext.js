import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";

export const AppContext = createContext(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside <AppProvider>");
  return ctx;
}

/** Run a read against the verified API; re-runs on every refresh (new block or manual). */
export function useChainQuery(fetcher, deps = []) {
  const { api, refreshKey } = useApp();
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    if (!api) {
      setState({ loading: false, data: null, error: null, unavailable: true });
      return undefined;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: s.data === null, unavailable: false }));
    fetcher(api)
      .then((data) => !cancelled && setState({ loading: false, data, error: null }))
      .catch((error) => !cancelled && setState({ loading: false, data: null, error }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, refreshKey, ...deps]);
  return state;
}

/**
 * Transaction helper for one UI section, identified by `key`. The guards live in the
 * application-level store (state/txStore.js), so they survive navigation and remounts:
 * one operation at a time (duplicate-submission guard), and an UNKNOWN result keeps the section
 * paused until a read-only status check resolves it or the user explicitly acknowledges it.
 * The contract remains the security boundary; this prevents accidental duplicate submissions.
 */
export function useTx(key) {
  const { refresh, txStore } = useApp();
  const state = useSyncExternalStore(txStore.subscribe, () => txStore.get(key));
  return {
    record: state.record,
    busy: state.busy || !!state.unresolved,
    unresolved: state.unresolved,
    checking: state.checking,
    run: (operation) => txStore.run(key, operation, refresh),
    reconcile: () => txStore.reconcile(key, refresh),
    acknowledge: () => txStore.acknowledge(key, refresh),
    clear: () => txStore.clear(key),
  };
}
