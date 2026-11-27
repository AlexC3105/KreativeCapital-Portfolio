// Failed transfers, fee-on-transfer receipts, reentrancy,
// plain ETH (rules R-X1..R-X4, R-K6). Uses the TEST-ONLY MockConfigurableToken.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { snapshot } = require("../helpers/manager");

const Mode = { Normal: 0, ReturnFalse: 1, Revert: 2, FeeOnTransfer: 3, Reenter: 4 };
const U = (n) => ethers.parseUnits(String(n), 18);

async function mockFixture() {
  const [owner, alice, bob, carol] = await ethers.getSigners();
  const token = await ethers.deployContract("MockConfigurableToken");
  const manager = await ethers.deployContract("CampaignManager", [await token.getAddress()]);
  for (const s of [owner, alice, bob, carol]) await token.mint(s.address, U(1_000_000));
  const managerAddr = await manager.getAddress();
  async function give(signer, id, amount) {
    await token.connect(signer).approve(managerAddr, amount);
    await manager.connect(signer).contribute(id, amount);
  }
  // id 1: will succeed (goal 100, 150 contributed); id 2: will fail (goal 1000, 60 contributed)
  await manager.connect(alice).createCampaign(U(100), 600n, "S", "");
  await manager.connect(alice).createCampaign(U(1000), 600n, "F", "");
  await give(bob, 1n, U(150));
  await give(carol, 2n, U(60));
  await time.increase(600);
  await manager.finalize(1n);
  await manager.finalize(2n);
  return { token, manager, owner, alice, bob, carol, actors: [owner, alice, bob, carol] };
}

describe("CampaignManager: failed transfers roll back (T-X01, T-X02)", function () {
  const claims = [
    ["creator payout", (f) => f.manager.connect(f.alice).claimCreatorPayout(1n), (f) => f.alice, U(150) - U(150) / 100n],
    ["refund", (f) => f.manager.connect(f.carol).claimRefund(2n), (f) => f.carol, U(60)],
    ["platform fees", (f) => f.manager.connect(f.owner).claimPlatformFees(), (f) => f.owner, U(150) / 100n],
  ];
  for (const [label, claim, who, amount] of claims) {
    it(`${label}: a transfer returning false reverts; entitlement stays claimable`, async function () {
      const f = await loadFixture(mockFixture);
      await f.token.setMode(Mode.ReturnFalse);
      const before = await snapshot(f.manager, f.token, f.actors);
      await expect(claim(f)).to.be.revertedWith("SafeERC20: ERC20 operation did not succeed");
      expect(await snapshot(f.manager, f.token, f.actors)).to.deep.equal(before);
      await f.token.setMode(Mode.Normal);
      await expect(claim(f)).to.changeTokenBalance(f.token, who(f), amount);
    });

    it(`${label}: a reverting transfer reverts; entitlement stays claimable`, async function () {
      const f = await loadFixture(mockFixture);
      await f.token.setMode(Mode.Revert);
      const before = await snapshot(f.manager, f.token, f.actors);
      await expect(claim(f)).to.be.revertedWith("MockToken: transfer reverted");
      expect(await snapshot(f.manager, f.token, f.actors)).to.deep.equal(before);
      await f.token.setMode(Mode.Normal);
      await expect(claim(f)).to.changeTokenBalance(f.token, who(f), amount);
    });
  }
});

describe("CampaignManager: exact receipt and reentrancy", function () {
  it("rejects a contribution whose received amount differs (fee-on-transfer) (T-K06)", async function () {
    const [owner, alice, bob] = await ethers.getSigners();
    const token = await ethers.deployContract("MockConfigurableToken");
    const manager = await ethers.deployContract("CampaignManager", [await token.getAddress()]);
    await token.mint(bob.address, U(1000));
    await manager.connect(alice).createCampaign(U(100), 600n, "x", "");
    await token.setMode(Mode.FeeOnTransfer);
    await token.connect(bob).approve(await manager.getAddress(), U(10));
    const before = await snapshot(manager, token, [owner, alice, bob]);
    const expectedReceived = U(10) - (U(10) / 100n + 1n);
    await expect(manager.connect(bob).contribute(1n, U(10)))
      .to.be.revertedWithCustomError(manager, "ReceivedAmountMismatch")
      .withArgs(U(10), expectedReceived);
    expect(await snapshot(manager, token, [owner, alice, bob])).to.deep.equal(before);
  });

  it("blocks reentry during an outgoing transfer; state is unchanged (T-X03)", async function () {
    const f = await loadFixture(mockFixture);
    await f.token.setReentry(await f.manager.getAddress(), f.manager.interface.encodeFunctionData("claimRefund", [2n]));
    await f.token.setMode(Mode.Reenter);
    const before = await snapshot(f.manager, f.token, f.actors);
    await expect(f.manager.connect(f.carol).claimRefund(2n)).to.be.revertedWith("ReentrancyGuard: reentrant call");
    expect(await snapshot(f.manager, f.token, f.actors)).to.deep.equal(before);
  });

  for (const [label, call, reentry] of [
    ["claimCreatorPayout", (f) => f.manager.connect(f.alice).claimCreatorPayout(1n), (f) => f.manager.interface.encodeFunctionData("claimCreatorPayout", [1n])],
  ]) {
    it(`blocks reentry during ${label}; state is unchanged (T-X03)`, async function () {
      const f = await loadFixture(mockFixture);
      await f.token.setReentry(await f.manager.getAddress(), reentry(f));
      await f.token.setMode(Mode.Reenter);
      const before = await snapshot(f.manager, f.token, f.actors);
      await expect(call(f)).to.be.revertedWith("ReentrancyGuard: reentrant call");
      expect(await snapshot(f.manager, f.token, f.actors)).to.deep.equal(before);
    });
  }

  it("rejects a non-owner reentry into claimPlatformFees via onlyOwner (T-X03)", async function () {
    const f = await loadFixture(mockFixture);
    await f.token.setReentry(await f.manager.getAddress(), f.manager.interface.encodeFunctionData("claimPlatformFees"));
    await f.token.setMode(Mode.Reenter);
    const before = await snapshot(f.manager, f.token, f.actors);
    // The re-entering caller is the token contract, which is not the owner.
    await expect(f.manager.connect(f.owner).claimPlatformFees()).to.be.revertedWith("Ownable: caller is not the owner");
    expect(await snapshot(f.manager, f.token, f.actors)).to.deep.equal(before);
  });

  it("blocks an owner re-entering claimPlatformFees via nonReentrant (T-X03)", async function () {
    const f = await loadFixture(mockFixture);
    const managerAddr = await f.manager.getAddress();
    const probe = await ethers.deployContract("MockEthRejector");
    const probeAddr = await probe.getAddress();
    await f.manager.connect(f.owner).transferOwnership(probeAddr);
    await probe.acceptOwnershipOf(managerAddr);
    const claimData = f.manager.interface.encodeFunctionData("claimPlatformFees");
    // During the outgoing transfer the token calls probe.forward(manager, claimPlatformFees),
    // so the re-entrant call comes from the owner and reaches the reentrancy guard.
    await f.token.setReentry(probeAddr, probe.interface.encodeFunctionData("forward", [managerAddr, claimData]));
    await f.token.setMode(Mode.Reenter);
    const actors = [...f.actors];
    const before = await snapshot(f.manager, f.token, actors);
    await expect(probe.forward(managerAddr, claimData)).to.be.revertedWith("ReentrancyGuard: reentrant call");
    expect(await snapshot(f.manager, f.token, actors)).to.deep.equal(before);
    await f.token.setMode(Mode.Normal);
    await expect(probe.forward(managerAddr, claimData)).to.changeTokenBalance(f.token, probe, U(150) / 100n);
  });

  it("blocks reentry during contribute (inbound transferFrom hook); state is unchanged (T-X03)", async function () {
    const [owner, alice, bob] = await ethers.getSigners();
    const token = await ethers.deployContract("MockConfigurableToken");
    const manager = await ethers.deployContract("CampaignManager", [await token.getAddress()]);
    await token.mint(bob.address, U(1000));
    await manager.connect(alice).createCampaign(U(100), 600n, "x", "");
    await token.connect(bob).approve(await manager.getAddress(), U(10));
    await token.setReentry(await manager.getAddress(), manager.interface.encodeFunctionData("contribute", [1n, U(1)]));
    await token.setMode(Mode.Reenter);
    const before = await snapshot(manager, token, [owner, alice, bob]);
    await expect(manager.connect(bob).contribute(1n, U(10))).to.be.revertedWith("ReentrancyGuard: reentrant call");
    expect(await snapshot(manager, token, [owner, alice, bob])).to.deep.equal(before);
  });

  it("keeps the ledger consistent under cross-function reentry into unguarded createCampaign/finalize (Slither reentrancy-no-eth review)", async function () {
    const [owner, alice, bob] = await ethers.getSigners();
    const token = await ethers.deployContract("MockConfigurableToken");
    const manager = await ethers.deployContract("CampaignManager", [await token.getAddress()]);
    const managerAddr = await manager.getAddress();
    await token.mint(bob.address, U(1000));
    await manager.connect(alice).createCampaign(U(100), 600n, "target", "");
    await manager.connect(alice).createCampaign(U(100), 60n, "other", "");
    await time.increase(61); // campaign 2 has ended; campaign 1 is still open
    await token.connect(bob).approve(managerAddr, U(10));

    // Re-enter finalize(2) during the inbound transferFrom of contribute(1, 10).
    await token.setReentry(managerAddr, manager.interface.encodeFunctionData("finalize", [2n]));
    await token.setMode(Mode.Reenter);
    await manager.connect(bob).contribute(1n, U(10));
    expect((await manager.getCampaign(2n)).status).to.equal(2n); // finalized (Failed, no contributions)
    expect((await manager.getCampaign(1n)).totalContributed).to.equal(U(10));
    expect(await manager.totalOutstanding()).to.equal(U(10));
    expect(await token.balanceOf(managerAddr)).to.equal(await manager.totalOutstanding());

    // Re-entering finalize of the SAME campaign is impossible: same block, deadline not reached.
    await token.connect(bob).approve(managerAddr, U(5));
    await token.setReentry(managerAddr, manager.interface.encodeFunctionData("finalize", [1n]));
    await expect(manager.connect(bob).contribute(1n, U(5))).to.be.revertedWithCustomError(manager, "CampaignNotEnded");
    expect((await manager.getCampaign(1n)).totalContributed).to.equal(U(10));

    // Re-entering createCampaign registers an unrelated campaign; accounting is unaffected.
    await token.setReentry(managerAddr, manager.interface.encodeFunctionData("createCampaign", [U(1), 60n, "reentrant", ""]));
    await manager.connect(bob).contribute(1n, U(5));
    expect(await manager.campaignCount()).to.equal(3n);
    expect((await manager.getCampaign(3n)).creator).to.equal(await token.getAddress());
    expect(await manager.totalOutstanding()).to.equal(U(15));
    expect(await token.balanceOf(managerAddr)).to.equal(U(15));
    void owner;
  });

  it("rejects plain ETH sent to the manager (T-X04)", async function () {
    const f = await loadFixture(mockFixture);
    const managerAddr = await f.manager.getAddress();
    await expect(f.alice.sendTransaction({ to: managerAddr, value: 1n })).to.be.revertedWithoutReason();
    expect(await ethers.provider.getBalance(managerAddr)).to.equal(0n);
  });
});
