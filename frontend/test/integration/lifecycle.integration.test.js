// Local-chain integration checks: the frontend's real lib layer against a live Hardhat
// node. Wallets are minimal EIP-1193 adapters over the node's unlocked development accounts
// (test-only; no private keys). Time travel and the insolvency simulation use Hardhat RPC
// methods (test-only).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { AbiCoder, BrowserProvider, getAddress, JsonRpcProvider, keccak256, parseEther, toBeHex } from "ethers";
import { validateManifest } from "../../src/lib/manifest.js";
import { verifyDeployment, verifyWalletChain } from "../../src/lib/verify.js";
import { buildWriteContext } from "../../src/lib/writeContext.js";
import { createApi, Phase } from "../../src/lib/api.js";
import { createActions } from "../../src/lib/actions.js";
import { TxState } from "../../src/lib/tx.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const abiDir = path.resolve(here, "..", "..", "src", "abi");
const artifacts = {
  KreativeToken: JSON.parse(fs.readFileSync(path.join(abiDir, "KreativeToken.json"), "utf8")),
  CampaignManager: JSON.parse(fs.readFileSync(path.join(abiDir, "CampaignManager.json"), "utf8")),
};
const KT = (n) => BigInt(n) * 10n ** 18n;

let manifest, rpc, api, accounts;
let OWNER, ALICE, BOB, CAROL, DAVE;

/** Minimal EIP-1193 wallet over the node's unlocked dev account (test-only). */
function wallet(address, { chainId = "0x7a69", reject = false, genesis = null, fakeSend = false, replayHash = null, switchChainAfterChecks = null } = {}) {
  const w = {
    address,
    chainId,
    switchTo: null,
    switchChainTo: null,
    sent: [], // eth_sendTransaction params actually received by the wallet
    hashes: [],
    chainChecks: 0,
    async request({ method, params = [] }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [w.address];
      if (method === "eth_chainId") {
        const answer = w.chainId;
        w.chainChecks += 1;
        // The wallet switches network after answering N chain checks (between preparation and submission).
        if (switchChainAfterChecks !== null && w.chainChecks >= switchChainAfterChecks) w.chainId = "0x1";
        return answer;
      }
      if (genesis && method === "eth_getBlockByNumber") return { hash: genesis }; // a different 31337 chain instance
      if (method === "eth_sendTransaction") {
        if (reject) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        w.sent.push(params[0]);
        if (fakeSend) return "0x" + "77".repeat(32); // a hash that never gets mined (uncertain confirmation)
        if (replayHash) return replayHash; // conflicting response: an unrelated, already mined hash
        const hash = await rpc.send(method, params);
        w.hashes.push(hash);
        if (w.switchTo) w.address = w.switchTo; // account switched while the tx is pending
        if (w.switchChainTo) w.chainId = w.switchChainTo; // network switched while the tx is pending
        return hash;
      }
      return rpc.send(method, params);
    },
  };
  return w;
}

function session(eip1193, m = manifest, { receiptTimeoutMs, artifactsOverride } = {}) {
  let expected = null;
  const getWriteContext = async () => {
    const accs = await eip1193.request({ method: "eth_accounts" });
    expected ??= getAddress(accs[0]);
    return buildWriteContext({ provider: rpc, manifest: m, artifacts: artifactsOverride ?? artifacts, eip1193, expectedAccount: expected, createBrowserProvider: (p) => new BrowserProvider(p) });
  };
  const actions = createActions({ api, getWriteContext, receiptTimeoutMs });
  if (!process.env.KC_DEBUG) return actions;
  // Opt-in diagnostics: log every state transition.
  return Object.fromEntries(Object.entries(actions).map(([k, fn]) => [k, (...args) => fn(...args, (r) => console.log(k, r.state, r.message ?? ""))]));
}

async function warp(seconds) {
  await rpc.send("evm_increaseTime", [seconds]);
  await rpc.send("evm_mine", []);
}

async function createAndGetId(actions, args) {
  const r = await actions.createCampaign(args);
  expect(r.state, r.message).toBe(TxState.CONFIRMED);
  return r.result.id;
}

beforeAll(async () => {
  manifest = validateManifest(JSON.parse(fs.readFileSync(inject("manifestPath"), "utf8")));
  rpc = new JsonRpcProvider(manifest.rpcUrl, 31337, { staticNetwork: true });
  api = createApi({ provider: rpc, manifest, artifacts });
  [OWNER, ALICE, BOB, CAROL, DAVE] = (await rpc.send("eth_accounts", [])).map((a) => getAddress(a));
  accounts = { OWNER, ALICE, BOB, CAROL, DAVE };
  // Fund participants with KT through the real purchase action.
  for (const who of [ALICE, BOB, CAROL, DAVE]) {
    const r = await session(wallet(who)).buyTokens(parseEther("10"));
    expect(r.state, r.message).toBe(TxState.CONFIRMED);
  }
});

describe("deployment and wallet verification against the live chain", () => {
  it("verifies every deployment check and the wallet's chain instance", async () => {
    const result = await verifyDeployment(rpc, manifest, artifacts);
    expect(result.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(await verifyWalletChain(wallet(ALICE), manifest)).toEqual({ ok: true });
  });

  it("purchases reconcile: 10 ETH bought exactly 1,000 KT for each participant", async () => {
    for (const who of [ALICE, BOB, CAROL, DAVE]) expect(await api.token.balanceOf(who)).toBe(KT(1000));
    const p = await api.getPlatform();
    expect(p.token.tokensSold).toBe(KT(4000));
    expect(p.token.totalProceeds).toBe(parseEther("40"));
  });
});

describe("successful campaign lifecycle end to end", () => {
  it("create -> approve -> contribute -> finalize -> creator payout -> platform fee -> proceeds", async () => {
    const id = await createAndGetId(session(wallet(ALICE)), { goal: KT(100), duration: 120n, name: "Solar Garden ☀", description: "Integration" });
    const bob = session(wallet(BOB));
    const approve = await bob.approve(KT(150));
    expect(approve.state, approve.message).toBe(TxState.CONFIRMED);
    const contrib = await bob.contribute(id, KT(150));
    expect(contrib.state, contrib.message).toBe(TxState.CONFIRMED);
    expect(contrib.from).toBe(BOB);

    const early = await session(wallet(CAROL)).finalize(id);
    expect(early.state).toBe(TxState.BLOCKED);
    expect(early.message).toMatch(/deadline has not been reached/);

    await warp(121);
    const fin = await session(wallet(CAROL)).finalize(id); // permissionless
    expect(fin.state, fin.message).toBe(TxState.CONFIRMED);
    const { campaign } = await api.getCampaign(id);
    expect(campaign.phase).toBe(Phase.Successful);
    expect(campaign.platformFee).toBe(KT(150) / 100n);
    expect(campaign.creatorEntitlement).toBe(KT(150) - KT(150) / 100n);

    const wrongClaimant = await session(wallet(BOB)).claimCreatorPayout(id);
    expect(wrongClaimant.state).toBe(TxState.BLOCKED);
    expect(wrongClaimant.message).toMatch(/Only the campaign creator/);

    const aliceBefore = await api.token.balanceOf(ALICE);
    const payout = await session(wallet(ALICE)).claimCreatorPayout(id);
    expect(payout.state, payout.message).toBe(TxState.CONFIRMED);
    expect((await api.token.balanceOf(ALICE)) - aliceBefore).toBe(KT(148) + KT(1) / 2n);
    const again = await session(wallet(ALICE)).claimCreatorPayout(id);
    expect(again.state).toBe(TxState.BLOCKED);
    expect(again.message).toMatch(/already been claimed/);

    const notOwner = await session(wallet(BOB)).claimPlatformFees();
    expect(notOwner.state).toBe(TxState.BLOCKED);
    expect(notOwner.message).toMatch(/on-chain owner/);
    const fees = await session(wallet(OWNER)).claimPlatformFees();
    expect(fees.state, fees.message).toBe(TxState.CONFIRMED);
    const proceeds = await session(wallet(OWNER)).withdrawProceeds();
    expect(proceeds.state, proceeds.message).toBe(TxState.CONFIRMED);

    const p = await api.getPlatform();
    expect(p.manager.isSolvent).toBe(true);
    expect(p.manager.tokenBalance).toBe(p.manager.totalOutstanding);
    expect(p.token.unwithdrawnProceeds).toBe(0n);
  });
});

describe("failed campaign lifecycle end to end", () => {
  it("contributions -> finalize Failed -> full refunds once each; no payout, no fee", async () => {
    const before = await api.getPlatform();
    const id = await createAndGetId(session(wallet(ALICE)), { goal: KT(1000), duration: 60n, name: "Too ambitious", description: "" });
    for (const [who, amount] of [[BOB, KT(30)], [DAVE, KT(20)], [ALICE, KT(5)]]) {
      const s = session(wallet(who));
      expect((await s.approve(amount)).state).toBe(TxState.CONFIRMED);
      expect((await s.contribute(id, amount)).state).toBe(TxState.CONFIRMED);
    }
    await warp(61);
    expect((await session(wallet(DAVE)).finalize(id)).state).toBe(TxState.CONFIRMED);
    expect((await api.getCampaign(id)).campaign.phase).toBe(Phase.Failed);
    expect((await api.getPlatform()).manager.platformFeesOutstanding).toBe(before.manager.platformFeesOutstanding);

    const payout = await session(wallet(ALICE)).claimCreatorPayout(id);
    expect(payout.state).toBe(TxState.BLOCKED);
    for (const [who, amount] of [[BOB, KT(30)], [DAVE, KT(20)], [ALICE, KT(5)]]) {
      const b0 = await api.token.balanceOf(who);
      const r = await session(wallet(who)).claimRefund(id);
      expect(r.state, r.message).toBe(TxState.CONFIRMED);
      expect((await api.token.balanceOf(who)) - b0).toBe(amount);
    }
    const repeat = await session(wallet(BOB)).claimRefund(id);
    expect(repeat.state).toBe(TxState.BLOCKED);
    expect(repeat.message).toMatch(/already been claimed/);
    const none = await session(wallet(CAROL)).claimRefund(id);
    expect(none.message).toMatch(/nothing to claim/);
    expect((await api.getCampaign(id)).campaign.outstanding).toBe(0n);
  });
});

describe("write safety on the live chain", () => {
  it("reports a wallet rejection without changing state", async () => {
    const before = await api.token.balanceOf(BOB);
    const r = await session(wallet(BOB, { reject: true })).buyTokens(parseEther("1"));
    expect(r.state).toBe(TxState.REJECTED);
    expect(await api.token.balanceOf(BOB)).toBe(before);
  });

  it("blocks writes from a wallet on an unexpected network", async () => {
    const r = await session(wallet(BOB, { chainId: "0x1" })).buyTokens(parseEther("1"));
    expect(r.state).toBe(TxState.BLOCKED);
    expect(r.message).toMatch(/chain 1/);
  });

  it("blocks writes when the manifest does not match the chain instance (stale)", async () => {
    const stale = structuredClone(manifest);
    stale.genesisHash = "0x" + "ab".repeat(32);
    const result = await verifyDeployment(rpc, stale, artifacts);
    expect(result).toMatchObject({ ok: false, stale: true });
    const r = await session(wallet(BOB), stale).buyTokens(parseEther("1"));
    expect(r.state).toBe(TxState.BLOCKED);
    expect(r.message).toMatch(/not verified/);
  });

  it("discloses the remaining allowance when a contribution cannot proceed, and revokes it", async () => {
    const id = await createAndGetId(session(wallet(ALICE)), { goal: KT(10), duration: 3600n, name: "Allowance check", description: "" });
    const carol = session(wallet(CAROL));
    expect((await carol.approve(KT(10))).state).toBe(TxState.CONFIRMED);
    const tooMuch = await carol.contribute(id, KT(20));
    expect(tooMuch.state).toBe(TxState.BLOCKED);
    expect(tooMuch.message).toMatch(/allowance/);
    expect((await api.getCampaign(id, CAROL)).me.allowance).toBe(KT(10));
    const revoke = await carol.approve(0n);
    expect(revoke.state, revoke.message).toBe(TxState.CONFIRMED);
    expect((await api.getCampaign(id, CAROL)).me.allowance).toBe(0n);
  });

  it("attributes a transaction to the submitting account even if the wallet switches while pending", async () => {
    const id = await createAndGetId(session(wallet(ALICE)), { goal: KT(10), duration: 3600n, name: "Switch check", description: "" });
    const w = wallet(DAVE);
    const s = session(w);
    expect((await s.approve(KT(3))).state).toBe(TxState.CONFIRMED);
    w.switchTo = CAROL; // the wallet will switch to CAROL right after submitting the next tx
    const r = await s.contribute(id, KT(3));
    expect(r.state, r.message).toBe(TxState.CONFIRMED);
    expect(r.from).toBe(DAVE);
    expect(await api.manager.contributionOf(id, DAVE)).toBe(KT(3));
    expect(await api.manager.contributionOf(id, CAROL)).toBe(0n);
    // The next write from the switched wallet is refused until the UI re-reads the account.
    const stale = await s.contribute(id, KT(1));
    expect(stale.state).toBe(TxState.BLOCKED);
    expect(stale.message).toMatch(/account or network changed/);
  });

  it("represents insolvency: contributions and claims blocked, finalization allowed, automatic recovery", async () => {
    const id = await createAndGetId(session(wallet(ALICE)), { goal: KT(1000), duration: 60n, name: "Insolvency check", description: "" });
    const bob = session(wallet(BOB));
    expect((await bob.approve(KT(10))).state).toBe(TxState.CONFIRMED);
    expect((await bob.contribute(id, KT(10))).state).toBe(TxState.CONFIRMED);
    // TEST-ONLY: lower the manager's token balance via the ERC20 _balances slot (slot 0).
    const slot = keccak256(AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [api.managerAddress, 0]));
    const original = BigInt(await rpc.getStorage(api.tokenAddress, slot));
    expect(original).toBe(await api.token.balanceOf(api.managerAddress));
    await rpc.send("hardhat_setStorageAt", [api.tokenAddress, slot, toBeHex(original - KT(4), 32)]);

    const p = await api.getPlatform();
    expect(p.manager.isSolvent).toBe(false);
    expect(p.manager.shortfall).toBe(KT(4));
    const blocked = await session(wallet(DAVE)).contribute(id, KT(1));
    expect(blocked.state).toBe(TxState.BLOCKED);
    await warp(61);
    expect((await session(wallet(CAROL)).finalize(id)).state).toBe(TxState.CONFIRMED); // accounting-only
    const refund = await bob.claimRefund(id);
    expect(refund.state).toBe(TxState.BLOCKED);
    expect(refund.message).toMatch(/solvency rule/);

    // Restoring backing with a direct transfer creates no contribution or claim.
    const tokenW = api.token.connect(await new BrowserProvider(wallet(DAVE)).getSigner(DAVE));
    await (await tokenW.transfer(api.managerAddress, KT(4))).wait();
    expect((await api.getPlatform()).manager.isSolvent).toBe(true);
    expect(await api.manager.contributionOf(id, DAVE)).toBe(0n);
    const recovered = await bob.claimRefund(id);
    expect(recovered.state, recovered.message).toBe(TxState.CONFIRMED);
  });
});

describe("adversarial and boundary conditions", () => {
  it("keeps attribution and blocks the next write when the network changes while a tx is pending", async () => {
    const w = wallet(CAROL);
    const s = session(w);
    w.switchChainTo = "0x1";
    const r = await s.buyTokens(parseEther("1"));
    expect(r.state, r.message).toBe(TxState.CONFIRMED); // receipt read from the verified local RPC
    expect(r.from).toBe(CAROL);
    const next = await s.buyTokens(parseEther("1"));
    expect(next.state).toBe(TxState.BLOCKED);
    expect(next.message).toMatch(/chain 1/);
  });

  it("blocks a wallet on the same chain id but a different chain instance", async () => {
    expect((await verifyWalletChain(wallet(BOB, { genesis: "0x" + "ee".repeat(32) }), manifest)).code).toBe("different-chain");
    const r = await session(wallet(BOB, { genesis: "0x" + "ee".repeat(32) })).buyTokens(parseEther("1"));
    expect(r.state).toBe(TxState.BLOCKED);
    expect(r.message).toMatch(/different chain/);
  });

  it("rejects runtime bytecode that does not match the manifest or the compiled artifact", async () => {
    const badHash = structuredClone(manifest);
    badHash.contracts.CampaignManager.runtimeCodeHash = "0x" + "12".repeat(32);
    const v1 = await verifyDeployment(rpc, badHash, artifacts);
    expect(v1.checks.find((c) => c.id === "CampaignManager:code").ok).toBe(false);
    const tampered = structuredClone(artifacts);
    tampered.CampaignManager.deployedBytecode = tampered.CampaignManager.deployedBytecode.replace(/.{4}$/, "beef");
    const v2 = await verifyDeployment(rpc, manifest, tampered);
    expect(v2.checks.find((c) => c.id === "CampaignManager:artifact").ok).toBe(false);
    const r = await session(wallet(BOB), manifest, { artifactsOverride: tampered }).buyTokens(parseEther("1"));
    expect(r.state).toBe(TxState.BLOCKED);
  });

  it("reports an unconfirmed submission as UNKNOWN after the receipt timeout (no false success or failure)", async () => {
    const r = await session(wallet(BOB, { fakeSend: true }), manifest, { receiptTimeoutMs: 1500 }).buyTokens(parseEther("1"));
    expect(r.state).toBe(TxState.UNKNOWN);
    expect(r.message).toMatch(/outcome is uncertain/i);
    expect(r.message).not.toMatch(/reconciliation/i); // no automatic reconciliation is implied
  });

  // FR-02 / FR-04 regressions.
  it("pins the verified sender, destination contract and chain id 31337 in the request the wallet receives", async () => {
    const w = wallet(BOB);
    const r = await session(w).buyTokens(parseEther("1"));
    expect(r.state, r.message).toBe(TxState.CONFIRMED);
    expect(w.sent).toHaveLength(1);
    expect(BigInt(w.sent[0].chainId)).toBe(31337n);
    expect(getAddress(w.sent[0].from)).toBe(BOB);
    expect(getAddress(w.sent[0].to)).toBe(manifest.contracts.KreativeToken.address);
    expect(r.chainId).toBe("31337");
  });

  it("refuses to submit when the wallet switches network between preparation and submission", async () => {
    const before = await api.token.balanceOf(BOB);
    const w = wallet(BOB, { switchChainAfterChecks: 1 });
    const r = await session(w).buyTokens(parseEther("1"));
    expect(r.state).toBe(TxState.BLOCKED);
    expect(r.message).toMatch(/chain 1/);
    expect(w.sent).toHaveLength(0); // the wallet was never asked to sign
    expect(await api.token.balanceOf(BOB)).toBe(before);
  });

  it("treats a conflicting wallet response (another account's mined hash) as UNKNOWN, never success or failure", async () => {
    const carol = wallet(CAROL);
    expect((await session(carol).buyTokens(parseEther("1"))).state).toBe(TxState.CONFIRMED);
    const r = await session(wallet(BOB, { replayHash: carol.hashes[0] })).buyTokens(parseEther("1"));
    expect(r.state).toBe(TxState.UNKNOWN);
    expect(r.message).toMatch(/different account/);
  });

  it("treats a replayed hash of the same account's earlier identical transaction as UNKNOWN", async () => {
    const bob = wallet(BOB);
    expect((await session(bob).buyTokens(parseEther("1"))).state).toBe(TxState.CONFIRMED);
    const r = await session(wallet(BOB, { replayHash: bob.hashes[0] })).buyTokens(parseEther("1"));
    expect(r.state).toBe(TxState.UNKNOWN);
    expect(r.message).toMatch(/mined before this action was submitted/);
  });

  // TR-02 regressions: "Check status" reuses the original evidence (receiptTimeoutMs 0 forces UNKNOWN).
  it("status check confirms a valid late receipt only after the full original verification", async () => {
    const before = await api.token.balanceOf(BOB);
    const r = await session(wallet(BOB), manifest, { receiptTimeoutMs: 0 }).buyTokens(parseEther("1"));
    expect(r).toMatchObject({ state: TxState.UNKNOWN, evidence: "not-found" });
    const checked = await r.resolve();
    expect(checked.state, checked.message).toBe(TxState.CONFIRMED);
    expect(checked.evidence).toBe("verified");
    expect(await api.token.balanceOf(BOB)).toBe(before + KT(100));
  });

  it("status check never accepts another account's transaction or a replay of an earlier one", async () => {
    const carol = wallet(CAROL);
    expect((await session(carol).buyTokens(parseEther("1"))).state).toBe(TxState.CONFIRMED);
    const unrelated = await session(wallet(BOB, { replayHash: carol.hashes[0] }), manifest, { receiptTimeoutMs: 0 }).buyTokens(parseEther("1"));
    expect(unrelated.state).toBe(TxState.UNKNOWN);
    expect(await unrelated.resolve()).toMatchObject({ state: TxState.UNKNOWN, evidence: "mismatch", message: expect.stringMatching(/different account/) });

    const bob = wallet(BOB);
    expect((await session(bob).buyTokens(parseEther("1"))).state).toBe(TxState.CONFIRMED);
    const replay = await session(wallet(BOB, { replayHash: bob.hashes[0] }), manifest, { receiptTimeoutMs: 0 }).buyTokens(parseEther("1"));
    expect(await replay.resolve()).toMatchObject({ state: TxState.UNKNOWN, evidence: "mismatch", message: expect.stringMatching(/mined before this action was submitted/) });

    // A mismatch detected on time offers no status check at all.
    const onTime = await session(wallet(BOB, { replayHash: bob.hashes[0] })).buyTokens(parseEther("1"));
    expect(onTime).toMatchObject({ state: TxState.UNKNOWN, evidence: "mismatch" });
    expect(onTime.resolve).toBeUndefined();
  });

  it("reconciles concurrent activity across campaigns and accounts", async () => {
    const before = await api.getPlatform();
    const a = await createAndGetId(session(wallet(ALICE)), { goal: KT(40), duration: 600n, name: "Concurrent A", description: "" });
    const b = await createAndGetId(session(wallet(BOB)), { goal: KT(400), duration: 600n, name: "Concurrent B", description: "" });
    const plan = [[CAROL, a, KT(15)], [DAVE, b, KT(7)], [CAROL, b, KT(3)], [DAVE, a, KT(30)], [ALICE, b, KT(2)]];
    for (const [who, id, amount] of plan) {
      const s = session(wallet(who));
      expect((await s.approve(amount)).state).toBe(TxState.CONFIRMED);
      expect((await s.contribute(id, amount)).state).toBe(TxState.CONFIRMED);
    }
    expect((await api.getCampaign(a)).campaign.totalContributed).toBe(KT(45));
    expect((await api.getCampaign(b)).campaign.totalContributed).toBe(KT(12));
    const after = await api.getPlatform();
    expect(after.manager.totalOutstanding - before.manager.totalOutstanding).toBe(KT(57));
    expect(after.manager.tokenBalance).toBe(after.manager.totalOutstanding + after.manager.excessBalance);
    await warp(601);
    expect((await session(wallet(OWNER)).finalize(a)).state).toBe(TxState.CONFIRMED);
    expect((await session(wallet(OWNER)).finalize(b)).state).toBe(TxState.CONFIRMED);
    expect((await api.getCampaign(a)).campaign.phase).toBe(Phase.Successful);
    expect((await api.getCampaign(b)).campaign.phase).toBe(Phase.Failed);
  });

  it("applies deadline equality: at the deadline contributions are rejected and finalization is allowed", async () => {
    const id = await createAndGetId(session(wallet(ALICE)), { goal: KT(1), duration: 300n, name: "Deadline equality", description: "" });
    const { campaign } = await api.getCampaign(id);
    const s = session(wallet(BOB));
    expect((await s.approve(KT(1))).state).toBe(TxState.CONFIRMED);
    await rpc.send("evm_setNextBlockTimestamp", [Number(campaign.deadline)]);
    await rpc.send("evm_mine", []); // latest block timestamp == deadline
    // Raw RPC read (ethers caches identical getBlock("latest") requests for a short time).
    const latest = await rpc.send("eth_getBlockByNumber", ["latest", false]);
    expect(BigInt(latest.timestamp)).toBe(campaign.deadline);
    const late = await s.contribute(id, KT(1));
    expect(late.state).toBe(TxState.BLOCKED);
    expect(late.message).toMatch(/deadline has been reached/);
    expect((await session(wallet(CAROL)).finalize(id)).state).toBe(TxState.CONFIRMED);
  });
});

describe("read API against the live chain", () => {
  it("paginates newest first and aggregates account claims", async () => {
    const { count } = await api.getCampaignPage(0, 3);
    const first = await api.getCampaignPage(0, 3);
    const ids = first.campaigns.map((c) => c.id);
    expect(ids).toEqual([count, count - 1n, count - 2n]);
    const last = await api.getCampaignPage(Number((count - 1n) / 3n), 3);
    expect(last.campaigns[last.campaigns.length - 1].id).toBe(1n);
    expect((await api.getCampaignPage(Number(count), 3)).campaigns).toEqual([]);

    const bob = await api.getAccount(BOB);
    expect(bob.contributions.length).toBeGreaterThan(0);
    for (const x of bob.contributions) expect(await api.manager.contributionOf(x.campaign.id, BOB)).toBe(x.amount);
    for (const r of bob.refunds) expect(r.campaign.status).toBe(2);
    expect(bob.isManagerOwner).toBe(false);
    const owner = await api.getAccount(OWNER);
    expect(owner.isManagerOwner && owner.isTokenOwner).toBe(true);
  });
});
