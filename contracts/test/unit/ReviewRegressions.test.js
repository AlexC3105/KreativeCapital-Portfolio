// Regression tests adopted from the Stage 7 independent review (R1-R6).
// R1 documents a scope limit rather than a defect: the solvency guard checks B >= L before each
// outgoing transfer and relies on the canonical KreativeToken moving exactly `amount`. A
// non-standard outgoing-fee token (test-only mock) shows what happens outside that assumption.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const U = (n) => ethers.parseUnits(String(n), 18);

describe("Review regressions: solvency guard scope (canonical-token assumption)", function () {
  it("R1: with an out-of-scope outgoing-fee token, the pre-transfer check lets one claim create a shortfall; later claims are then stopped", async function () {
    const [owner, alice, bob, carol] = await ethers.getSigners();
    const token = await ethers.deployContract("MockOutgoingFeeToken");
    const m = await ethers.deployContract("CampaignManager", [await token.getAddress()]);
    const ma = await m.getAddress();
    for (const s of [bob, carol]) await token.mint(s.address, U(1000));
    await m.connect(alice).createCampaign(U(1000), 600n, "F", "");
    for (const s of [bob, carol]) { await token.connect(s).approve(ma, U(100)); await m.connect(s).contribute(1n, U(100)); }
    await time.increase(600);
    await m.finalize(1n);
    await token.setTaxSender(ma);
    expect(await m.isSolvent()).to.equal(true);
    await expect(m.connect(bob).claimRefund(1n)).to.changeTokenBalance(token, bob, U(100)); // passes the guard
    expect(await m.shortfall()).to.equal(U(1)); // 1% of the 100 KT refund burned from the manager
    expect(await m.isSolvent()).to.equal(false);
    await expect(m.connect(carol).claimRefund(1n)).to.be.revertedWithCustomError(m, "Insolvent");
  });
});

describe("Review regressions: cross-function reentrancy", function () {
  it("R2: contribute -> (transferFrom hook) -> claimRefund on another, failed campaign is blocked by the shared guard", async function () {
    const [owner, alice, bob] = await ethers.getSigners();
    const token = await ethers.deployContract("MockConfigurableToken");
    const m = await ethers.deployContract("CampaignManager", [await token.getAddress()]);
    const ma = await m.getAddress();
    await token.mint(bob.address, U(1000));
    await m.connect(alice).createCampaign(U(1000), 60n, "F", "");
    await token.connect(bob).approve(ma, U(10)); await m.connect(bob).contribute(1n, U(10));
    await time.increase(60); await m.finalize(1n);
    await m.connect(alice).createCampaign(U(1000), 600n, "open", "");
    await token.connect(bob).approve(ma, U(5));
    await token.setReentry(ma, m.interface.encodeFunctionData("claimRefund", [1n]));
    await token.setMode(4); // Mode.Reenter
    await expect(m.connect(bob).contribute(2n, U(5))).to.be.revertedWith("ReentrancyGuard: reentrant call");
  });

  it("R3: claimRefund -> (transfer hook) -> finalize/createCampaign succeeds and leaves the ledger consistent", async function () {
    const [owner, alice, bob] = await ethers.getSigners();
    const token = await ethers.deployContract("MockConfigurableToken");
    const m = await ethers.deployContract("CampaignManager", [await token.getAddress()]);
    const ma = await m.getAddress();
    await token.mint(bob.address, U(1000));
    await m.connect(alice).createCampaign(U(1000), 60n, "F", "");
    await m.connect(alice).createCampaign(U(1), 60n, "S", "");
    await token.connect(bob).approve(ma, U(30));
    await m.connect(bob).contribute(1n, U(10)); await m.connect(bob).contribute(2n, U(20));
    await time.increase(60); await m.finalize(1n);
    await token.setReentry(ma, m.interface.encodeFunctionData("finalize", [2n]));
    await token.setMode(4); // Mode.Reenter
    await m.connect(bob).claimRefund(1n);
    expect((await m.getCampaign(2n)).status).to.equal(1n);
    expect(await m.totalOutstanding()).to.equal(U(20));
    expect(await m.tokenBalance()).to.equal(U(20));
    expect(await m.platformFeesOutstanding()).to.equal(U(20) / 100n);
  });
});

describe("Review regressions: KreativeToken custody and conversion", function () {
  it("R4: nobody (incl. owner) can move the reserve except buyTokens; reserve is a multiple of 100 and fully sellable", async function () {
    const [owner, alice] = await ethers.getSigners();
    const t = await ethers.deployContract("KreativeToken");
    const ta = await t.getAddress();
    await expect(t.connect(owner).transferFrom(ta, owner.address, 1n)).to.be.revertedWith("ERC20: insufficient allowance");
    expect((await t.saleReserve()) % 100n).to.equal(0n);
    await t.connect(alice).buyTokens({ value: 3n });
    expect(await t.balanceOf(alice.address)).to.equal(300n);
    expect((await t.saleReserve()) % 100n).to.equal(0n);
  });

  it("R5: with KT, insolvency is unreachable via normal flows; a donation is excess, never credited", async function () {
    const [owner, alice, bob, carol] = await ethers.getSigners();
    const t = await ethers.deployContract("KreativeToken");
    const m = await ethers.deployContract("CampaignManager", [await t.getAddress()]);
    const ma = await m.getAddress();
    for (const s of [alice, bob, carol]) await t.connect(s).buyTokens({ value: ethers.parseEther("10") });
    await m.connect(alice).createCampaign(U(100), 60n, "S", "");
    await t.connect(bob).approve(ma, U(200)); await m.connect(bob).contribute(1n, U(150));
    await t.connect(carol).transfer(ma, U(7));
    await time.increase(60); await m.finalize(1n);
    await m.connect(alice).claimCreatorPayout(1n);
    await m.connect(owner).claimPlatformFees();
    expect(await m.totalOutstanding()).to.equal(0n);
    expect(await m.excessBalance()).to.equal(U(7));
    expect(await t.balanceOf(alice.address)).to.equal(U(1000) + U(150) - U(150) / 100n);
  });
});

describe("Review regressions: ownership", function () {
  it("R6: a pending ownership transfer can be cancelled, the cancelled pending owner cannot accept, and renouncing is disabled", async function () {
    const [owner, alice, bob] = await ethers.getSigners();
    const t = await ethers.deployContract("KreativeToken");
    const m = await ethers.deployContract("CampaignManager", [await t.getAddress()]);
    await m.transferOwnership(alice.address);
    await m.transferOwnership(ethers.ZeroAddress); // cancels
    await expect(m.connect(alice).acceptOwnership()).to.be.revertedWith("Ownable2Step: caller is not the new owner");
    await expect(m.renounceOwnership()).to.be.revertedWithCustomError(m, "RenounceDisabled");
    expect(await m.owner()).to.equal(owner.address);
  });
});
