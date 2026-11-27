// T-A01 / T-A07 / R-G7: the canonical contracts expose exactly the specified state-changing
// surface. No mint, burn, escrow withdrawal, outcome override, pause, guardian, upgrade or
// test/corruption hook exists.
const { expect } = require("chai");
const { artifacts } = require("hardhat");

function mutating(abi) {
  return abi
    .filter((e) => e.type === "function" && !["view", "pure"].includes(e.stateMutability))
    .map((e) => e.name)
    .sort();
}

describe("ABI surface of the canonical contracts", function () {
  it("KreativeToken: ERC-20, purchases, proceeds withdrawal, two-step ownership only", async function () {
    const { abi } = await artifacts.readArtifact("KreativeToken");
    expect(mutating(abi)).to.deep.equal(
      [
        "acceptOwnership",
        "approve",
        "buyTokens",
        "decreaseAllowance",
        "increaseAllowance",
        "transfer",
        "transferFrom",
        "transferOwnership",
        "withdrawProceeds",
      ].sort()
    );
    const payable = abi.filter((e) => e.stateMutability === "payable").map((e) => e.name);
    expect(payable).to.deep.equal(["buyTokens"]);
    expect(abi.some((e) => e.type === "receive" || e.type === "fallback")).to.equal(false);
    const renounce = abi.find((e) => e.name === "renounceOwnership");
    expect(renounce.stateMutability).to.equal("pure");
  });

  it("CampaignManager: lifecycle, claims and two-step ownership only", async function () {
    const { abi } = await artifacts.readArtifact("CampaignManager");
    expect(mutating(abi)).to.deep.equal(
      [
        "acceptOwnership",
        "claimCreatorPayout",
        "claimPlatformFees",
        "claimRefund",
        "contribute",
        "createCampaign",
        "finalize",
        "transferOwnership",
      ].sort()
    );
    expect(abi.some((e) => e.stateMutability === "payable")).to.equal(false);
    expect(abi.some((e) => e.type === "receive" || e.type === "fallback")).to.equal(false);
    expect(abi.find((e) => e.name === "renounceOwnership").stateMutability).to.equal("pure");
  });
});
