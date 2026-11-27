// Financial actions. Each one: revalidate context -> simulate -> wallet submission -> receipt
// (via the read RPC) -> expected event -> block-tagged state verification. Amounts are exact
// bigint base units.
import { describeError } from "./errors.js";
import { BlockedError, runTransaction } from "./tx.js";
import { EXPECTED_CHAIN_ID } from "./manifest.js";
import { ktForWei } from "./units.js";

const RECEIPT_TIMEOUT_MS = 120_000;
const RECEIPT_POLL_MS = 250;
const at = (blockNumber) => ({ blockTag: blockNumber });

/**
 * @param {object} p
 * @param {ReturnType<import('./api.js').createApi>} p.api
 * @param {() => Promise<{ok: boolean, reason?: string, account?: string, signer?: object}>} p.getWriteContext
 */
export function createActions({ api, getWriteContext, receiptTimeoutMs = RECEIPT_TIMEOUT_MS }) {
  const { token, manager, managerAddress, tokenAddress, provider } = api;
  const interfaces = [manager.interface, token.interface];
  const describe = (e) => describeError(e, interfaces);
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  // Poll the read RPC for the receipt explicitly. provider.waitForTransaction depends on block
  // subscriptions and can wait for a further block that never arrives on a quiet local chain
  // (found by the local-chain integration tests). Returns null on timeout (-> UNKNOWN).
  const waitForReceipt = async (hash) => {
    const deadline = Date.now() + receiptTimeoutMs;
    while (Date.now() < deadline) {
      const receipt = await provider.getTransactionReceipt(hash);
      if (receipt) return receipt;
      await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_MS));
    }
    return null;
  };
  // Submit through the wallet and return as soon as it hands back the transaction hash.
  // (JsonRpcSigner.sendTransaction would keep polling the wallet for the transaction without a
  // timeout and fails if the wallet changes network while pending; confirmation is instead
  // established only by bounded receipt polling against the verified read RPC.)
  // The request is pinned to the verified sender, the expected contract and chain 31337, and the
  // wallet context is re-checked immediately before the wallet is asked to sign. The pinned
  // chainId lets a standards-compliant wallet refuse to sign for another chain; whether it does
  // is the wallet's responsibility.
  async function submit(ctx, contract, method, args = [], overrides = {}) {
    const populated = await contract.getFunction(method).populateTransaction(...args, overrides);
    const request = { ...populated, from: ctx.account, chainId: BigInt(EXPECTED_CHAIN_ID) };
    const expectedTo = await contract.getAddress();
    if (!same(request.to, expectedTo) || !same(request.from, ctx.account) || request.chainId !== BigInt(EXPECTED_CHAIN_ID)) {
      throw new BlockedError("The transaction request did not match the verified contract, account or chain. Nothing was submitted.");
    }
    const fresh = ctx.recheck ? await ctx.recheck() : { ok: true };
    if (!fresh.ok) throw new BlockedError(fresh.reason);
    const startBlock = await provider.getBlockNumber();
    const hash = await ctx.signer.sendUncheckedTransaction(request);
    return { hash, request, startBlock };
  }

  // Compare what was actually mined with what was requested (read via the verified RPC). A
  // mismatch, e.g. a wallet returning an unrelated hash, never counts as success or failure.
  async function checkMined({ hash, request, startBlock, receipt, ctx }) {
    if (!request) return null;
    if (!same(receipt.from, ctx.account)) return "The mined transaction was sent by a different account than the one that started this action.";
    if (!same(receipt.to, request.to)) return "The mined transaction was sent to a different contract than requested.";
    if (startBlock !== undefined && receipt.blockNumber <= startBlock) return "The returned transaction was mined before this action was submitted.";
    const mined = await provider.getTransaction(hash);
    if (!mined) return "The mined transaction could not be read back from the local node.";
    if (String(mined.data).toLowerCase() !== String(request.data).toLowerCase() || BigInt(mined.value ?? 0n) !== BigInt(request.value ?? 0n)) {
      return "The mined transaction's data or value differs from the request.";
    }
    if (mined.chainId !== undefined && mined.chainId !== null && BigInt(mined.chainId) !== BigInt(EXPECTED_CHAIN_ID)) {
      return "The mined transaction is not for the local development chain.";
    }
    return null;
  }

  async function ktDelta(account, n) {
    return (await token.balanceOf(account, at(n))) - (await token.balanceOf(account, at(n - 1)));
  }

  function run(spec, onUpdate) {
    return runTransaction({ describe, waitForReceipt, getReceipt, checkChain, checkMined, prepare: getWriteContext, onUpdate, ...spec });
  }

  // Read-only helpers for the "Check status" reconciliation of an UNKNOWN result.
  const getReceipt = (hash) => provider.getTransactionReceipt(hash);
  const checkChain = async () => !api.genesisHash || (await provider.getBlock(0))?.hash === api.genesisHash;

  return {
    buyTokens(weiValue, onUpdate) {
      const expected = ktForWei(weiValue);
      return run(
        {
          label: "Buy KT",
          simulate: (ctx) => token.buyTokens.staticCall({ value: weiValue, from: ctx.account }),
          send: (ctx) => submit(ctx, token, "buyTokens", [], { value: weiValue }),
          expectEvent: (ctx) => ({
            contract: token,
            address: tokenAddress,
            name: "TokensPurchased",
            match: (a) => same(a.buyer, ctx.account) && a.ethPaid === weiValue && a.tokensBought === expected,
          }),
          verify: async ({ receipt, ctx }) => {
            const n = receipt.blockNumber;
            const reserveDelta = (await token.saleReserve(at(n - 1))) - (await token.saleReserve(at(n)));
            return (await ktDelta(ctx.account, n)) === expected && reserveDelta === expected;
          },
        },
        onUpdate
      );
    },

    approve(amount, onUpdate) {
      return run(
        {
          label: amount === 0n ? "Revoke KT allowance" : "Approve KT allowance",
          simulate: (ctx) => token.approve.staticCall(managerAddress, amount, { from: ctx.account }),
          send: (ctx) => submit(ctx, token, "approve", [managerAddress, amount]),
          expectEvent: (ctx) => ({
            contract: token,
            address: tokenAddress,
            name: "Approval",
            match: (a) => same(a.owner, ctx.account) && same(a.spender, managerAddress) && a.value === amount,
          }),
          verify: async ({ receipt, ctx }) => (await token.allowance(ctx.account, managerAddress, at(receipt.blockNumber))) === amount,
        },
        onUpdate
      );
    },

    createCampaign({ goal, duration, name, description }, onUpdate) {
      return run(
        {
          label: "Create campaign",
          simulate: (ctx) => manager.createCampaign.staticCall(goal, duration, name, description, { from: ctx.account }),
          send: (ctx) => submit(ctx, manager, "createCampaign", [goal, duration, name, description]),
          expectEvent: (ctx) => ({
            contract: manager,
            address: managerAddress,
            name: "CampaignCreated",
            match: (a) => same(a.creator, ctx.account) && a.goal === goal && a.name === name,
          }),
          verify: async ({ receipt, event, ctx }) => {
            const c = await manager.getCampaign(event.args.id, at(receipt.blockNumber));
            return same(c.creator, ctx.account) && c.goal === goal && c.name === name && c.description === description;
          },
        },
        onUpdate
      );
    },

    contribute(id, amount, onUpdate) {
      return run(
        {
          label: `Contribute to campaign #${id}`,
          simulate: (ctx) => manager.contribute.staticCall(id, amount, { from: ctx.account }),
          send: (ctx) => submit(ctx, manager, "contribute", [id, amount]),
          expectEvent: (ctx) => ({
            contract: manager,
            address: managerAddress,
            name: "Contributed",
            match: (a) => a.id === BigInt(id) && same(a.contributor, ctx.account) && a.amount === amount,
          }),
          verify: async ({ receipt, ctx }) => {
            const n = receipt.blockNumber;
            const delta = (await manager.contributionOf(id, ctx.account, at(n))) - (await manager.contributionOf(id, ctx.account, at(n - 1)));
            return delta === amount && (await ktDelta(ctx.account, n)) === -amount;
          },
        },
        onUpdate
      );
    },

    finalize(id, onUpdate) {
      return run(
        {
          label: `Finalize campaign #${id}`,
          simulate: (ctx) => manager.finalize.staticCall(id, { from: ctx.account }),
          send: (ctx) => submit(ctx, manager, "finalize", [id]),
          expectEvent: () => ({ contract: manager, address: managerAddress, name: "Finalized", match: (a) => a.id === BigInt(id) }),
          verify: async ({ receipt, event }) => {
            const c = await manager.getCampaign(id, at(receipt.blockNumber));
            const expected = event.args.successful ? 1n : 2n;
            return c.status === expected && c.totalContributed === event.args.totalContributed;
          },
        },
        onUpdate
      );
    },

    claimCreatorPayout(id, onUpdate) {
      return run(
        {
          label: `Claim creator payout (#${id})`,
          simulate: (ctx) => manager.claimCreatorPayout.staticCall(id, { from: ctx.account }),
          send: (ctx) => submit(ctx, manager, "claimCreatorPayout", [id]),
          expectEvent: (ctx) => ({
            contract: manager,
            address: managerAddress,
            name: "CreatorPaid",
            match: (a) => a.id === BigInt(id) && same(a.creator, ctx.account),
          }),
          verify: async ({ receipt, event, ctx }) => {
            const c = await manager.getCampaign(id, at(receipt.blockNumber));
            return c.creatorPaid && (await ktDelta(ctx.account, receipt.blockNumber)) === event.args.amount;
          },
        },
        onUpdate
      );
    },

    claimRefund(id, onUpdate) {
      return run(
        {
          label: `Claim refund (#${id})`,
          simulate: (ctx) => manager.claimRefund.staticCall(id, { from: ctx.account }),
          send: (ctx) => submit(ctx, manager, "claimRefund", [id]),
          expectEvent: (ctx) => ({
            contract: manager,
            address: managerAddress,
            name: "Refunded",
            match: (a) => a.id === BigInt(id) && same(a.contributor, ctx.account),
          }),
          verify: async ({ receipt, event, ctx }) => {
            const n = receipt.blockNumber;
            const recorded = await manager.contributionOf(id, ctx.account, at(n));
            return (
              (await manager.refundClaimed(id, ctx.account, at(n))) &&
              event.args.amount === recorded &&
              (await ktDelta(ctx.account, n)) === recorded
            );
          },
        },
        onUpdate
      );
    },

    claimPlatformFees(onUpdate) {
      return run(
        {
          label: "Claim platform fees",
          simulate: (ctx) => manager.claimPlatformFees.staticCall({ from: ctx.account }),
          send: (ctx) => submit(ctx, manager, "claimPlatformFees"),
          expectEvent: (ctx) => ({ contract: manager, address: managerAddress, name: "PlatformFeesClaimed", match: (a) => same(a.to, ctx.account) }),
          verify: async ({ receipt, event, ctx }) => {
            const n = receipt.blockNumber;
            const before = await manager.platformFeesOutstanding(at(n - 1));
            const after = await manager.platformFeesOutstanding(at(n));
            return before - after === event.args.amount && (await ktDelta(ctx.account, n)) === event.args.amount;
          },
        },
        onUpdate
      );
    },

    withdrawProceeds(onUpdate) {
      return run(
        {
          label: "Withdraw sale proceeds",
          simulate: (ctx) => token.withdrawProceeds.staticCall({ from: ctx.account }),
          send: (ctx) => submit(ctx, token, "withdrawProceeds"),
          expectEvent: (ctx) => ({ contract: token, address: tokenAddress, name: "ProceedsWithdrawn", match: (a) => same(a.to, ctx.account) }),
          verify: async ({ receipt, event }) => {
            const n = receipt.blockNumber;
            const delta = (await token.proceedsWithdrawn(at(n))) - (await token.proceedsWithdrawn(at(n - 1)));
            return delta === event.args.amount;
          },
        },
        onUpdate
      );
    },
  };
}
