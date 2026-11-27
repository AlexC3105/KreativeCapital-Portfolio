// Application-level transaction guards (state/txStore.js): focused regression tests.
import { describe, expect, it } from "vitest";
import { createTxStore } from "../../src/state/txStore.js";
import { TxState } from "../../src/lib/tx.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

describe("txStore: stale status-check results (O-1)", () => {
  it("a check that completes after acknowledgement and a new action cannot interfere with the new action", async () => {
    const store = createTxStore();
    const KEY = "tokens";
    const check = deferred();
    const unknown = { label: "Buy KT", state: TxState.UNKNOWN, from: "0xB", hash: "0x01", evidence: "not-found", resolve: () => check.promise };

    // An uncertain outcome pauses the section.
    await store.run(KEY, async (onUpdate) => (onUpdate(unknown), unknown));
    expect(store.get(KEY).unresolved).toBe(unknown);

    // 1. Start "Check status" (still running).
    const reconciling = store.reconcile(KEY);
    expect(store.get(KEY).checking).toBe(true);

    // 2. Acknowledge the unresolved transaction.
    store.acknowledge(KEY);
    expect(store.get(KEY)).toMatchObject({ unresolved: null, checking: false });

    // 3. Begin a new action (pending).
    const second = deferred();
    const pending = { label: "Buy KT", state: TxState.PENDING, from: "0xB", hash: "0x02" };
    const running = store.run(KEY, (onUpdate) => (onUpdate(pending), second.promise));
    expect(store.get(KEY)).toMatchObject({ busy: true, record: pending, unresolved: null });

    // 4. The old status check completes with an uncertain (mismatch) result.
    check.resolve({ state: TxState.UNKNOWN, evidence: "mismatch", message: "stale result" });
    await reconciling;

    // 5. The old result changed nothing for the new action.
    expect(store.get(KEY)).toMatchObject({ busy: true, record: pending, unresolved: null, checking: false });

    const confirmed = { label: "Buy KT", state: TxState.CONFIRMED, from: "0xB", hash: "0x02" };
    second.resolve(confirmed);
    await running;
    expect(store.get(KEY)).toMatchObject({ busy: false, unresolved: null, checking: false });
    expect(store.get(KEY).record).toBe(pending); // the operation only reported PENDING via onUpdate
  });

  it("a late successful result also cannot unlock or relabel a newer pause", async () => {
    const store = createTxStore();
    const KEY = "campaign:1:contribute";
    const check = deferred();
    const first = { label: "Contribute", state: TxState.UNKNOWN, from: "0xB", hash: "0x01", evidence: "not-found", resolve: () => check.promise };
    await store.run(KEY, async () => first);
    const reconciling = store.reconcile(KEY);
    store.acknowledge(KEY);
    const second = { label: "Contribute", state: TxState.UNKNOWN, from: "0xB", hash: "0x03", evidence: "not-found", resolve: async () => ({ state: TxState.UNKNOWN, evidence: "not-found" }) };
    await store.run(KEY, async (onUpdate) => (onUpdate(second), second)); // runTransaction always reports via onUpdate
    check.resolve({ state: TxState.CONFIRMED, evidence: "verified", message: "old confirmation" });
    await reconciling;
    expect(store.get(KEY).unresolved).toBe(second); // the newer pause stays in place
    expect(store.get(KEY).record).toBe(second);
  });
});
