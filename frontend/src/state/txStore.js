// Application-level transaction guards (in memory, for the lifetime of the open tab).
// Each UI section (key) has: the latest record, a pending flag and an unresolved UNKNOWN lock.
// Kept outside components so the guards survive route changes and remounts, and so an
// operation that finishes after its page unmounted still updates them. Nothing is persisted:
// a full browser reload clears these guards (the chain itself is unaffected).
import { TxState } from "../lib/tx.js";

const EMPTY = Object.freeze({ record: null, busy: false, unresolved: null, checking: false });
const RESOLVED = new Set([TxState.CONFIRMED, TxState.REVERTED]);
// Evidence states for which another read-only status check is meaningful.
const CHECKABLE = new Set(["not-found", "check-failed"]);

export function createTxStore() {
  let sections = {};
  const listeners = new Set();
  const get = (key) => sections[key] ?? EMPTY;
  const set = (key, patch) => {
    sections = { ...sections, [key]: { ...get(key), ...patch } };
    listeners.forEach((l) => l());
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get,

    /** One operation at a time per section; refused while pending or unresolved. Never retries. */
    async run(key, operation, onDone) {
      const current = get(key);
      if (current.busy || current.unresolved) return null;
      set(key, { busy: true });
      try {
        const result = await operation((record) => set(key, { record }));
        if (result?.state === TxState.UNKNOWN) set(key, { unresolved: result });
        return result;
      } finally {
        set(key, { busy: false });
        onDone?.();
      }
    },

    /**
     * Read-only status check of the unresolved submission, using its original evidence.
     * Unlocks only when the outcome is known (confirmed and verified, or reverted).
     */
    async reconcile(key, onDone) {
      const r = get(key).unresolved;
      if (!r?.resolve || get(key).checking) return;
      set(key, { checking: true });
      let outcome;
      try {
        outcome = await r.resolve();
      } catch {
        outcome = { state: TxState.UNKNOWN, evidence: "check-failed", message: "The status check could not reach the local node. The outcome remains uncertain." };
      }
      // Identity check: if the pause this check started from was acknowledged, replaced or
      // resolved meanwhile, the late result is discarded and changes nothing (no status, no
      // checking flag, no new lock) for whatever the section is doing now.
      if (get(key).unresolved !== r) return;
      const next = { ...r, ...outcome, resolve: CHECKABLE.has(outcome.evidence) ? r.resolve : undefined };
      set(key, { checking: false, record: next, unresolved: RESOLVED.has(next.state) ? null : next });
      onDone?.();
    },

    /** Explicit user acknowledgement. Releases the pause but proves nothing about the outcome. */
    acknowledge(key, onDone) {
      const r = get(key).unresolved;
      if (!r) return;
      set(key, {
        unresolved: null,
        checking: false,
        record: {
          ...r,
          resolve: undefined,
          acknowledged: true,
          message: "You confirmed you have checked your wallet. This is not proof that the transaction succeeded, and its outcome is still uncertain. Check the figures on this page before any new action.",
        },
      });
      onDone?.();
    },

    clear(key) {
      set(key, { record: null });
    },
  };
}
