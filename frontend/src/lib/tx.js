// Evidence-based transaction runner. A wallet submission is never reported as success: the
// operation is CONFIRMED only when the receipt succeeded, the expected event is present and a
// fresh contract-state check agrees. Anything less ends as BLOCKED, REJECTED, REVERTED or
// UNKNOWN. UNKNOWN means the outcome is uncertain: it is never shown as success or failure, and
// there is no automatic reconciliation (a no-receipt UNKNOWN carries a read-only resolve() for the
// user's "Check status"; the per-section pause lives in state/txStore.js).

/** Thrown by a submission step to refuse before anything reaches the wallet. */
export class BlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "BlockedError";
    this.kcBlocked = true;
  }
}

export const TxState = Object.freeze({
  VALIDATING: "validating",
  BLOCKED: "blocked",
  AWAITING_WALLET: "awaiting-wallet",
  REJECTED: "rejected",
  SUBMITTED: "submitted",
  PENDING: "pending",
  VERIFYING: "verifying",
  CONFIRMED: "confirmed",
  REVERTED: "reverted",
  UNKNOWN: "unknown",
});

export const TERMINAL = new Set([TxState.BLOCKED, TxState.REJECTED, TxState.CONFIRMED, TxState.REVERTED, TxState.UNKNOWN]);

export const STATE_LABELS = {
  [TxState.VALIDATING]: "Checking network, deployment and account…",
  [TxState.BLOCKED]: "Not submitted",
  [TxState.AWAITING_WALLET]: "Awaiting approval in your wallet…",
  [TxState.REJECTED]: "Rejected in wallet",
  [TxState.SUBMITTED]: "Submitted",
  [TxState.PENDING]: "Pending confirmation…",
  [TxState.VERIFYING]: "Verifying receipt, event and contract state…",
  [TxState.CONFIRMED]: "Confirmed and verified",
  [TxState.REVERTED]: "Reverted",
  [TxState.UNKNOWN]: "Unknown: confirmation uncertain",
};

/** Find the first log from `address` that parses as `name` and satisfies `match`. */
export function findEvent(receipt, { contract, address, name, match }) {
  for (const log of receipt.logs ?? []) {
    if (String(log.address).toLowerCase() !== String(address).toLowerCase()) continue;
    let parsed;
    try {
      parsed = contract.interface.parseLog(log);
    } catch {
      continue;
    }
    if (parsed && parsed.name === name && (!match || match(parsed.args))) return parsed;
  }
  return null;
}

/**
 * @param {object} p
 * @param {string} p.label
 * @param {() => Promise<{ok: boolean, reason?: string, account?: string}>} p.prepare  revalidates context
 * @param {(ctx) => Promise<void>} p.simulate  eth_call preflight (throws on revert)
 * @param {(ctx) => Promise<{hash: string}>} p.send  wallet submission
 * @param {(hash: string) => Promise<object|null>} p.waitForReceipt  via the read RPC
 * @param {(ctx) => object} p.expectEvent  { contract, address, name, match }
 * @param {(args) => Promise<boolean|string>} p.verify  fresh state check ({receipt, event, ctx})
 * @param {(args) => Promise<string|null>} [p.checkMined]  mined tx vs request; a message on mismatch
 * @param {(hash: string) => Promise<object|null>} [p.getReceipt]  single receipt lookup (status check)
 * @param {() => Promise<boolean>} [p.checkChain]  true while the chain instance is unchanged
 * @param {(err) => {kind: string, message: string}} p.describe
 * @param {(record) => void} [p.onUpdate]
 */
export async function runTransaction({ label, prepare, simulate, send, waitForReceipt, getReceipt = waitForReceipt, checkChain = null, checkMined = async () => null, expectEvent, verify, describe, onUpdate = () => {} }) {
  const record = { label, state: TxState.VALIDATING, startedAt: Date.now() };
  const update = (patch) => {
    Object.assign(record, patch);
    const snapshot = { ...record };
    onUpdate(snapshot);
    return snapshot;
  };
  update({});

  let ctx;
  try {
    ctx = await prepare();
  } catch (e) {
    return update({ state: TxState.BLOCKED, message: describe(e).message });
  }
  if (!ctx?.ok) return update({ state: TxState.BLOCKED, message: ctx?.reason ?? "Writes are unavailable." });
  update({ from: ctx.account, chainId: ctx.chainId !== undefined ? String(ctx.chainId) : undefined });

  try {
    await simulate(ctx);
  } catch (e) {
    const d = describe(e);
    if (d.kind === "network") return update({ state: TxState.BLOCKED, message: d.message });
    return update({ state: TxState.BLOCKED, message: `The contract would reject this: ${d.message}`, errorName: d.name });
  }

  update({ state: TxState.AWAITING_WALLET });
  let tx;
  try {
    tx = await send(ctx);
  } catch (e) {
    if (e?.kcBlocked) return update({ state: TxState.BLOCKED, message: e.message });
    const d = describe(e);
    if (d.kind === "rejected") return update({ state: TxState.REJECTED, message: d.message });
    if (d.kind === "revert") return update({ state: TxState.REVERTED, message: d.message, errorName: d.name });
    return update({
      state: TxState.UNKNOWN,
      message: `Submission status unknown (${d.message}). No transaction hash was returned. Check your wallet's activity list before trying again.`,
    });
  }

  update({ state: TxState.SUBMITTED, hash: tx.hash });
  update({ state: TxState.PENDING });

  // Every receipt (on time or found later by "Check status") goes through the same checks:
  // request match, receipt status, expected event and block-tagged contract state.
  const evaluate = async (receipt) => {
    let mismatch;
    try {
      mismatch = await checkMined({ hash: tx.hash, request: tx.request, startBlock: tx.startBlock, receipt, ctx });
    } catch {
      mismatch = "The mined transaction could not be checked against the request.";
    }
    if (mismatch) {
      return { state: TxState.UNKNOWN, blockNumber: receipt.blockNumber, evidence: "mismatch", message: `${mismatch} Not counted as success or failure.` };
    }
    if (receipt.status !== 1) {
      return { state: TxState.REVERTED, blockNumber: receipt.blockNumber, evidence: "reverted", message: "Mined but reverted. No state changed." };
    }
    const event = findEvent(receipt, expectEvent(ctx));
    if (!event) {
      return { state: TxState.UNKNOWN, blockNumber: receipt.blockNumber, evidence: "unverified", message: "The receipt matches the request but does not contain the expected event, so the outcome is uncertain. Check the balances on this page before any new action." };
    }
    let verified = false;
    try {
      verified = await verify({ receipt, event, ctx });
    } catch {
      verified = false;
    }
    if (!verified) {
      return { state: TxState.UNKNOWN, blockNumber: receipt.blockNumber, evidence: "unverified", message: "The receipt matches the request, but the contract state does not match the expected result, so the outcome is uncertain. Check the balances on this page before any new action." };
    }
    return {
      state: TxState.CONFIRMED,
      blockNumber: receipt.blockNumber,
      evidence: "verified",
      message: typeof verified === "string" ? verified : "Confirmed on-chain and verified against contract state.",
      result: event.args,
    };
  };

  let receipt;
  try {
    receipt = await waitForReceipt(tx.hash);
  } catch {
    receipt = null;
  }
  if (!receipt) {
    // Read-only reconciliation for this exact submission. It reuses the original evidence
    // (hash, account, request, submission block, expected event and state checks) and first
    // confirms the chain instance is unchanged. It never submits anything.
    const resolve = async () => {
      if (checkChain && !(await checkChain())) {
        return { state: TxState.UNKNOWN, evidence: "chain-changed", message: "The local chain is no longer the one this transaction was sent to, so it cannot be checked. The outcome remains uncertain." };
      }
      const late = await getReceipt(tx.hash);
      if (!late) return { state: TxState.UNKNOWN, evidence: "not-found", message: "Still no receipt for this hash on the local node. The outcome remains uncertain, so check your wallet's activity." };
      const outcome = await evaluate(late);
      if (outcome.state === TxState.CONFIRMED) return { ...outcome, message: "Confirmed and verified after the status check: the receipt matches the request, and the expected event and contract state agree." };
      return outcome;
    };
    return update({
      state: TxState.UNKNOWN,
      evidence: "not-found",
      resolve,
      message: "No receipt was found within the time limit, so the outcome is uncertain. Check this transaction hash in your wallet's activity, or use \"Check status\". Do not resubmit until it is resolved.",
    });
  }
  update({ state: TxState.VERIFYING, blockNumber: receipt.blockNumber });
  return update(await evaluate(receipt));
}
