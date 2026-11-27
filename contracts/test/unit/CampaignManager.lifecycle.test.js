// Creation, registry, contributions, deadlines and finalization
// (rules R-C*, R-K*, R-F*).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { KT, TOTAL_SUPPLY, deploySystemFixture, buyKT, contribute } = require("../helpers/fixtures");
const {
  Status,
  Phase,
  MIN_DURATION,
  MAX_DURATION,
  GAS,
  createCampaign,
  snapshot,
  expectLedger,
} = require("../helpers/manager");

async function fundedFixture() {
  const f = await deploySystemFixture();
  for (const s of [f.alice, f.bob, f.carol, f.dave]) await buyKT(f.token, s, KT(10_000));
  return f;
}

describe("CampaignManager: creation and registry", function () {
  it("stores a valid campaign, emits CampaignCreated and derives the deadline (T-C01)", async function () {
    const { manager, alice } = await loadFixture(fundedFixture);
    const goal = KT(500);
    const tx = await manager.connect(alice).createCampaign(goal, 3600n, "Solar Garden", "Community project");
    const block = await ethers.provider.getBlock((await tx.wait()).blockNumber);
    await expect(tx)
      .to.emit(manager, "CampaignCreated")
      .withArgs(1n, alice.address, goal, BigInt(block.timestamp) + 3600n, "Solar Garden");
    const c = await manager.getCampaign(1n);
    expect(c.creator).to.equal(alice.address);
    expect(c.createdAt).to.equal(BigInt(block.timestamp));
    expect(c.deadline).to.equal(BigInt(block.timestamp) + 3600n);
    expect(c.status).to.equal(Status.Active);
    expect(c.goal).to.equal(goal);
    expect(c.totalContributed).to.equal(0n);
    expect(c.platformFee).to.equal(0n);
    expect(c.creatorEntitlement).to.equal(0n);
    expect(c.outstanding).to.equal(0n);
    expect(c.creatorPaid).to.equal(false);
    expect(c.name).to.equal("Solar Garden");
    expect(c.description).to.equal("Community project");
    expect(await manager.phase(1n)).to.equal(Phase.Open);
  });

  it("assigns sequential ids from 1 and allows duplicate names (T-C02, T-C03)", async function () {
    const { manager, alice, bob } = await loadFixture(fundedFixture);
    expect(await manager.campaignCount()).to.equal(0n);
    const a = await createCampaign(manager, alice, { goal: KT(1), name: "Same" });
    const b = await createCampaign(manager, bob, { goal: KT(2), name: "Same" });
    const c = await createCampaign(manager, alice, { goal: KT(3), name: "Other" });
    expect([a.id, b.id, c.id]).to.deep.equal([1n, 2n, 3n]);
    expect(await manager.campaignCount()).to.equal(3n);
    expect((await manager.getCampaign(1n)).goal).to.equal(KT(1));
    expect((await manager.getCampaign(2n)).creator).to.equal(bob.address);
    expect((await manager.getCampaign(2n)).name).to.equal("Same");
  });

  it("enforces goal bounds: 0 < goal <= total supply (T-C04, T-B02)", async function () {
    const { manager, token, alice } = await loadFixture(fundedFixture);
    const before = await snapshot(manager, token, [alice]);
    await expect(manager.connect(alice).createCampaign(0n, 3600n, "x", "")).to.be.revertedWithCustomError(
      manager,
      "InvalidGoal"
    );
    await expect(manager.connect(alice).createCampaign(TOTAL_SUPPLY + 1n, 3600n, "x", "")).to.be.revertedWithCustomError(
      manager,
      "InvalidGoal"
    );
    expect(await snapshot(manager, token, [alice])).to.deep.equal(before);
    await createCampaign(manager, alice, { goal: TOTAL_SUPPLY });
    await createCampaign(manager, alice, { goal: 1n });
    expect(await manager.campaignCount()).to.equal(2n);
  });

  it("enforces duration bounds 60 s .. 365 days inclusive (T-C05)", async function () {
    const { manager, token, alice } = await loadFixture(fundedFixture);
    const before = await snapshot(manager, token, [alice]);
    for (const d of [0n, MIN_DURATION - 1n, MAX_DURATION + 1n]) {
      await expect(manager.connect(alice).createCampaign(KT(1), d, "x", "")).to.be.revertedWithCustomError(
        manager,
        "InvalidDuration"
      );
    }
    expect(await snapshot(manager, token, [alice])).to.deep.equal(before);
    await createCampaign(manager, alice, { goal: KT(1), duration: MIN_DURATION });
    await createCampaign(manager, alice, { goal: KT(1), duration: MAX_DURATION });
    expect(await manager.MIN_DURATION()).to.equal(MIN_DURATION);
    expect(await manager.MAX_DURATION()).to.equal(MAX_DURATION);
  });

  it("enforces UTF-8 byte-length metadata bounds (T-C06)", async function () {
    const { manager, token, alice } = await loadFixture(fundedFixture);
    const before = await snapshot(manager, token, [alice]);
    const bad = async (name, desc, err) =>
      expect(manager.connect(alice).createCampaign(KT(1), 3600n, name, desc)).to.be.revertedWithCustomError(manager, err);
    await bad("", "", "InvalidName");
    await bad("a".repeat(65), "", "InvalidName");
    await bad("😀".repeat(16) + "a", "", "InvalidName"); // 16 x 4 bytes + 1 = 65 bytes, 17 characters
    await bad("ok", "d".repeat(501), "InvalidDescription");
    await bad("ok", "é".repeat(251), "InvalidDescription"); // 502 bytes
    expect(await snapshot(manager, token, [alice])).to.deep.equal(before);
    await createCampaign(manager, alice, { goal: KT(1), name: "a".repeat(64), description: "d".repeat(500) });
    await createCampaign(manager, alice, { goal: KT(1), name: "😀".repeat(16), description: "é".repeat(250) });
    expect((await manager.getCampaign(2n)).name).to.equal("😀".repeat(16));
    await createCampaign(manager, alice, { goal: KT(1), name: "x", description: "" });
    expect(await manager.campaignCount()).to.equal(3n);
  });

  it("rejects unknown campaign ids everywhere (T-C07)", async function () {
    const { manager, token, owner, alice } = await loadFixture(fundedFixture);
    await createCampaign(manager, alice, { goal: KT(1) });
    const before = await snapshot(manager, token, [owner, alice]);
    for (const id of [0n, 2n, ethers.MaxUint256]) {
      const err = (p) => expect(p).to.be.revertedWithCustomError(manager, "UnknownCampaign").withArgs(id);
      await err(manager.connect(alice).contribute(id, 1n));
      await err(manager.connect(alice).finalize(id));
      await err(manager.connect(alice).claimCreatorPayout(id));
      await err(manager.connect(alice).claimRefund(id));
      await err(manager.getCampaign(id));
      await err(manager.phase(id));
      await err(manager.contributionOf(id, owner.address));
      await err(manager.refundClaimed(id, owner.address));
    }
    expect(await snapshot(manager, token, [owner, alice])).to.deep.equal(before);
  });

  it("paginates campaigns with a bounded page size", async function () {
    const { manager, alice } = await loadFixture(fundedFixture);
    for (let i = 0; i < 5; i++) await createCampaign(manager, alice, { goal: KT(i + 1), name: `c${i}` });
    const page = await manager.getCampaigns(2n, 2n);
    expect(page.map((c) => c.name)).to.deep.equal(["c1", "c2"]);
    expect((await manager.getCampaigns(4n, 50n)).map((c) => c.name)).to.deep.equal(["c3", "c4"]);
    expect(await manager.getCampaigns(6n, 10n)).to.have.lengthOf(0);
    expect(await manager.getCampaigns(1n, 0n)).to.have.lengthOf(0);
    await expect(manager.getCampaigns(1n, 51n)).to.be.revertedWithCustomError(manager, "InvalidPageSize").withArgs(51n);
    await expect(manager.getCampaigns(0n, 1n)).to.be.revertedWithCustomError(manager, "UnknownCampaign").withArgs(0n);
  });
});

describe("CampaignManager: contributions", function () {
  it("rejects zero, unapproved and underfunded contributions without state change (T-K01, T-K05)", async function () {
    const { manager, token, alice, bob, erin } = await loadFixture(fundedFixture);
    const { id } = await createCampaign(manager, alice, { goal: KT(100) });
    const before = await snapshot(manager, token, [bob, erin]);
    await expect(manager.connect(bob).contribute(id, 0n)).to.be.revertedWithCustomError(manager, "ZeroAmount");
    await expect(manager.connect(bob).contribute(id, KT(1))).to.be.revertedWith("ERC20: insufficient allowance"); // no allowance
    await token.connect(erin).approve(await manager.getAddress(), KT(1)); // erin holds no KT
    await expect(manager.connect(erin).contribute(id, KT(1))).to.be.revertedWith("ERC20: transfer amount exceeds balance");
    expect(await snapshot(manager, token, [bob, erin])).to.deep.equal(before);
  });

  it("sums repeat contributions per contributor and reports newTotal (T-K03)", async function () {
    const { manager, token, alice, bob, carol } = await loadFixture(fundedFixture);
    const { id } = await createCampaign(manager, alice, { goal: KT(100) });
    await expect(contribute(token, manager, bob, id, KT(10)))
      .to.emit(manager, "Contributed")
      .withArgs(id, bob.address, KT(10), KT(10));
    await expect(contribute(token, manager, carol, id, KT(5)))
      .to.emit(manager, "Contributed")
      .withArgs(id, carol.address, KT(5), KT(15));
    await contribute(token, manager, bob, id, KT(7));
    expect(await manager.contributionOf(id, bob.address)).to.equal(KT(17));
    expect(await manager.contributionOf(id, carol.address)).to.equal(KT(5));
    const c = await manager.getCampaign(id);
    expect(c.totalContributed).to.equal(KT(22));
    expect(c.outstanding).to.equal(KT(22));
    await expectLedger(manager, token, [bob, carol]);
  });

  it("accepts contributions above the goal until the deadline; reaching the goal does not close (T-K04)", async function () {
    const { manager, token, alice, bob, carol } = await loadFixture(fundedFixture);
    const { id } = await createCampaign(manager, alice, { goal: KT(10) });
    await contribute(token, manager, bob, id, KT(10));
    expect(await manager.phase(id)).to.equal(Phase.Open);
    await contribute(token, manager, carol, id, KT(25));
    expect((await manager.getCampaign(id)).totalContributed).to.equal(KT(35));
    expect((await manager.getCampaign(id)).status).to.equal(Status.Active);
  });

  it("accepts at deadline - 1 and rejects at the deadline and after (T-K02)", async function () {
    const { manager, token, alice, bob } = await loadFixture(fundedFixture);
    const { id, deadline } = await createCampaign(manager, alice, { goal: KT(10), duration: 600n });
    await token.connect(bob).approve(await manager.getAddress(), KT(3));
    await time.setNextBlockTimestamp(deadline - 1n);
    await manager.connect(bob).contribute(id, KT(1), GAS);
    expect(await manager.contributionOf(id, bob.address)).to.equal(KT(1));

    const before = await snapshot(manager, token, [bob]);
    await time.setNextBlockTimestamp(deadline);
    await expect(manager.connect(bob).contribute(id, KT(1), GAS)).to.be.revertedWithCustomError(manager, "CampaignEnded");
    await expect(manager.connect(bob).contribute(id, KT(1), GAS)).to.be.revertedWithCustomError(manager, "CampaignEnded");
    expect(await snapshot(manager, token, [bob])).to.deep.equal(before);
    expect(await manager.phase(id)).to.equal(Phase.AwaitingFinalization);
  });

  it("lets a creator contribute to their own campaign under the same rules (T-C08)", async function () {
    const { manager, token, alice, bob } = await loadFixture(fundedFixture);
    const { id, deadline } = await createCampaign(manager, alice, { goal: KT(100) });
    await contribute(token, manager, alice, id, KT(30));
    await contribute(token, manager, bob, id, KT(20));
    expect((await manager.getCampaign(id)).totalContributed).to.equal(KT(50));
    await time.increaseTo(deadline);
    await manager.finalize(id);
    const aliceBefore = await token.balanceOf(alice.address);
    await manager.connect(alice).claimRefund(id); // failed: creator refunded like any contributor
    expect(await token.balanceOf(alice.address)).to.equal(aliceBefore + KT(30));
    await expect(manager.connect(alice).claimCreatorPayout(id)).to.be.revertedWithCustomError(manager, "NotSuccessful");
  });
});

describe("CampaignManager: finalization", function () {
  it("rejects finalization at deadline - 1 and allows it at the deadline (T-F01)", async function () {
    const { manager, token, alice, bob } = await loadFixture(fundedFixture);
    const { id, deadline } = await createCampaign(manager, alice, { goal: KT(10), duration: 600n });
    await contribute(token, manager, bob, id, KT(10));
    await time.setNextBlockTimestamp(deadline - 1n);
    await expect(manager.connect(bob).finalize(id, GAS)).to.be.revertedWithCustomError(manager, "CampaignNotEnded");
    await time.setNextBlockTimestamp(deadline);
    await expect(manager.connect(bob).finalize(id, GAS))
      .to.emit(manager, "Finalized")
      .withArgs(id, true, KT(10), KT(10) / 100n);
  });

  it("is permissionless, executes exactly once and moves no tokens (T-F02, T-F03, T-F05)", async function () {
    const { manager, token, alice, bob, erin } = await loadFixture(fundedFixture);
    const { id, deadline } = await createCampaign(manager, alice, { goal: KT(10) });
    await contribute(token, manager, bob, id, KT(12));
    await time.increaseTo(deadline);
    const balancesBefore = await Promise.all(
      [await manager.getAddress(), alice.address, bob.address, erin.address].map((a) => token.balanceOf(a))
    );
    const ledgerBefore = await manager.totalOutstanding();
    await manager.connect(erin).finalize(id); // erin: not creator, owner or contributor
    const balancesAfter = await Promise.all(
      [await manager.getAddress(), alice.address, bob.address, erin.address].map((a) => token.balanceOf(a))
    );
    expect(balancesAfter).to.deep.equal(balancesBefore);
    expect(await manager.totalOutstanding()).to.equal(ledgerBefore);

    const before = await snapshot(manager, token, [bob]);
    await expect(manager.connect(alice).finalize(id)).to.be.revertedWithCustomError(manager, "AlreadyFinalized");
    expect(await snapshot(manager, token, [bob])).to.deep.equal(before);
  });

  for (const [label, contributed, expectedStatus] of [
    ["below goal -> Failed", KT(99), Status.Failed],
    ["exactly at goal -> Successful", KT(100), Status.Successful],
    ["above goal -> Successful", KT(150), Status.Successful],
  ]) {
    it(`determines the outcome from recorded contributions: ${label} (T-F04)`, async function () {
      const { manager, token, alice, bob } = await loadFixture(fundedFixture);
      const { id, deadline } = await createCampaign(manager, alice, { goal: KT(100) });
      await contribute(token, manager, bob, id, contributed);
      await time.increaseTo(deadline);
      await manager.finalize(id);
      const c = await manager.getCampaign(id);
      expect(c.status).to.equal(expectedStatus);
      expect(await manager.phase(id)).to.equal(expectedStatus === Status.Successful ? Phase.Successful : Phase.Failed);
      if (expectedStatus === Status.Successful) {
        expect(c.platformFee).to.equal(contributed / 100n);
        expect(c.creatorEntitlement).to.equal(contributed - contributed / 100n);
        expect(c.outstanding).to.equal(c.creatorEntitlement);
        expect(await manager.platformFeesOutstanding()).to.equal(contributed / 100n);
      } else {
        expect(c.platformFee).to.equal(0n);
        expect(c.creatorEntitlement).to.equal(0n);
        expect(c.outstanding).to.equal(contributed);
        expect(await manager.platformFeesOutstanding()).to.equal(0n);
      }
      await expectLedger(manager, token, [bob]);
    });
  }

  it("finalizes a zero-contribution campaign as Failed with nothing to refund (T-F06)", async function () {
    const { manager, token, alice, bob } = await loadFixture(fundedFixture);
    const { id, deadline } = await createCampaign(manager, alice, { goal: KT(1) });
    await time.increaseTo(deadline);
    await manager.finalize(id);
    expect((await manager.getCampaign(id)).status).to.equal(Status.Failed);
    await expect(manager.connect(bob).claimRefund(id)).to.be.revertedWithCustomError(manager, "NothingToClaim");
    await expectLedger(manager, token, [bob]);
  });
});
