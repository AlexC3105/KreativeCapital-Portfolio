// Helpers for CampaignManager tests: campaign creation, state snapshots, an independent
// liability formula and test-only insolvency simulation.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const Status = { Active: 0n, Successful: 1n, Failed: 2n };
const Phase = { Open: 0n, AwaitingFinalization: 1n, Successful: 2n, Failed: 3n };
const MIN_DURATION = 60n;
const MAX_DURATION = 365n * 24n * 60n * 60n;
// Explicit gas: send boundary txs without pre-estimation. solidity-coverage instruments the
// bytecode (much higher gas), so a larger limit is used only while coverage is running.
const GAS = { gasLimit: require("hardhat").__SOLIDITY_COVERAGE_RUNNING ? 25_000_000 : 1_000_000 };

function plainCampaign(c) {
  return {
    creator: c.creator,
    createdAt: c.createdAt,
    deadline: c.deadline,
    status: c.status,
    creatorPaid: c.creatorPaid,
    goal: c.goal,
    totalContributed: c.totalContributed,
    platformFee: c.platformFee,
    creatorEntitlement: c.creatorEntitlement,
    outstanding: c.outstanding,
    name: c.name,
    description: c.description,
  };
}

/** Create a campaign and return { id, deadline, createdAt }. */
async function createCampaign(manager, signer, { goal, duration = 3600n, name = "Campaign", description = "" }) {
  const tx = await manager.connect(signer).createCampaign(goal, duration, name, description);
  const receipt = await tx.wait();
  const event = receipt.logs.map((l) => manager.interface.parseLog(l)).find((e) => e && e.name === "CampaignCreated");
  const id = event.args.id;
  const c = await manager.getCampaign(id);
  return { id, deadline: c.deadline, createdAt: c.createdAt };
}

/** Full observable state for revert/no-change assertions. */
async function snapshot(manager, token, actors = []) {
  const count = await manager.campaignCount();
  const managerAddr = await manager.getAddress();
  const campaigns = [];
  for (let id = 1n; id <= count; id++) {
    const c = plainCampaign(await manager.getCampaign(id));
    c.contributions = await Promise.all(actors.map((a) => manager.contributionOf(id, a.address)));
    c.refunded = await Promise.all(actors.map((a) => manager.refundClaimed(id, a.address)));
    campaigns.push(c);
  }
  return {
    count,
    campaigns,
    platformFeesOutstanding: await manager.platformFeesOutstanding(),
    totalOutstanding: await manager.totalOutstanding(),
    managerBalance: await token.balanceOf(managerAddr),
    actorBalances: await Promise.all(actors.map((a) => token.balanceOf(a.address))),
    owner: await manager.owner(),
  };
}

/**
 * Independent liability formula (architecture §6.1), computed from records, never from the
 * stored ledger: L = Σ active T_c + Σ successful unpaid C_c + Σ failed unrefunded contributions + P.
 */
async function computeLiabilities(manager, actors) {
  const count = await manager.campaignCount();
  let L = await manager.platformFeesOutstanding();
  for (let id = 1n; id <= count; id++) {
    const c = await manager.getCampaign(id);
    if (c.status === Status.Active) L += c.totalContributed;
    else if (c.status === Status.Successful) L += c.creatorPaid ? 0n : c.totalContributed - c.platformFee;
    else {
      for (const a of actors) {
        if (!(await manager.refundClaimed(id, a.address))) L += await manager.contributionOf(id, a.address);
      }
    }
  }
  return L;
}

/** Assert I2/I3/I4: stored ledger = formula; balance = liabilities + expected excess. */
async function expectLedger(manager, token, actors, expectedExcess = 0n) {
  const L = await computeLiabilities(manager, actors);
  const balance = await token.balanceOf(await manager.getAddress());
  expect(await manager.totalOutstanding(), "totalOutstanding == formula").to.equal(L);
  expect(balance, "balance == liabilities + excess").to.equal(L + expectedExcess);
  expect(await manager.isSolvent()).to.equal(true);
  expect(await manager.excessBalance()).to.equal(expectedExcess);
  expect(await manager.shortfall()).to.equal(0n);
}

/**
 * TEST-ONLY insolvency simulation: overwrite KreativeToken._balances[holder] via
 * hardhat_setStorageAt. ERC20._balances is storage slot 0 in KreativeToken. The helper first
 * checks that the computed slot holds the current balance.
 */
async function setTokenBalanceUnsafe(token, holder, newBalance) {
  const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [holder, 0]));
  const tokenAddr = await token.getAddress();
  const current = BigInt(await ethers.provider.getStorage(tokenAddr, slot));
  expect(current, "balance slot located").to.equal(await token.balanceOf(holder));
  await network.provider.send("hardhat_setStorageAt", [tokenAddr, slot, ethers.toBeHex(newBalance, 32)]);
  expect(await token.balanceOf(holder)).to.equal(newBalance);
}

module.exports = {
  Status,
  Phase,
  MIN_DURATION,
  MAX_DURATION,
  GAS,
  plainCampaign,
  createCampaign,
  snapshot,
  computeLiabilities,
  expectLedger,
  setTokenBalanceUnsafe,
};
