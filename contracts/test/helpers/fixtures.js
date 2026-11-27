// Shared fixtures for contract tests (local Hardhat Network only).
const { ethers } = require("hardhat");

const KT = (n) => ethers.parseUnits(String(n), 18);
const TOTAL_SUPPLY = KT(1_000_000);
const TOKENS_PER_ETH = 100n;

async function deployTokenFixture() {
  const [owner, alice, bob, carol, dave, erin] = await ethers.getSigners();
  const token = await ethers.deployContract("KreativeToken");
  return { token, owner, alice, bob, carol, dave, erin };
}

async function deploySystemFixture() {
  const base = await deployTokenFixture();
  const manager = await ethers.deployContract("CampaignManager", [await base.token.getAddress()]);
  return { ...base, manager };
}

/** Buy `ktAmount` (base units, a multiple of 100 wei-equivalents) of KT for `signer`. */
async function buyKT(token, signer, ktAmount) {
  if (ktAmount % TOKENS_PER_ETH !== 0n) throw new Error("ktAmount must be divisible by 100");
  await token.connect(signer).buyTokens({ value: ktAmount / TOKENS_PER_ETH });
}

/** Approve exactly `amount` and contribute it. */
async function contribute(token, manager, signer, id, amount) {
  await token.connect(signer).approve(await manager.getAddress(), amount);
  return manager.connect(signer).contribute(id, amount);
}

module.exports = { KT, TOTAL_SUPPLY, TOKENS_PER_ETH, deployTokenFixture, deploySystemFixture, buyKT, contribute };
