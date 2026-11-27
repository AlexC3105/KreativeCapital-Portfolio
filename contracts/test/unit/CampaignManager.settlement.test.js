// Creator payouts, platform fees, refunds, authorization, isolation, unsolicited KT
// (rules R-S*, R-R*, R-A3/A4/A5, invariants I1-I8).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { KT, TOTAL_SUPPLY, deploySystemFixture, buyKT, contribute } = require("../helpers/fixtures");
const { Status, createCampaign, snapshot, expectLedger, plainCampaign } = require("../helpers/manager");

const OWNABLE = "Ownable: caller is not the owner";

async function fundedFixture() {
  const f = await deploySystemFixture();
  // 20,000 KT each so the largest deterministic total (12,345 KT + 7 base units) is fundable.
  for (const s of [f.owner, f.alice, f.bob, f.carol, f.dave]) await buyKT(f.token, s, KT(20_000));
  return f;
}

/** Create, fund and finalize one campaign. */
async function settled(f, { goal, contributions, creator = f.alice }) {
  const { id, deadline } = await createCampaign(f.manager, creator, { goal });
  for (const [signer, amount] of contributions) await contribute(f.token, f.manager, signer, id, amount);
  await time.increaseTo(deadline);
  await f.manager.finalize(id);
  return id;
}

describe("CampaignManager: successful campaigns", function () {
  for (const total of [1n, 99n, 100n, 101n, 199n, KT(12345) + 7n, KT(10_000)]) {
    it(`computes fee = floor(T/100) and creator = T - fee for T = ${total} base units (T-S01)`, async function () {
      const f = await loadFixture(fundedFixture);
      const id = await settled(f, { goal: total, contributions: [[f.bob, total]] });
      const fee = total / 100n;
      const c = await f.manager.getCampaign(id);
      expect(c.platformFee).to.equal(fee);
      expect(c.creatorEntitlement).to.equal(total - fee);
      expect(c.creatorEntitlement + c.platformFee).to.equal(total);
      await expect(f.manager.connect(f.alice).claimCreatorPayout(id)).to.changeTokenBalances(
        f.token,
        [f.alice, f.manager],
        [total - fee, -(total - fee)]
      );
      await expectLedger(f.manager, f.token, [f.bob]);
      expect(await f.manager.platformFeesOutstanding()).to.equal(fee);
    });
  }

  it("computes the fee on the full supply-sized total without overflow (T-B02)", async function () {
    const f = await loadFixture(deploySystemFixture);
    await ethers.provider.send("hardhat_setBalance", [f.bob.address, ethers.toQuantity(ethers.parseEther("20000"))]);
    await buyKT(f.token, f.bob, TOTAL_SUPPLY);
    const id = await settled(f, { goal: TOTAL_SUPPLY, contributions: [[f.bob, TOTAL_SUPPLY]] });
    const c = await f.manager.getCampaign(id);
    expect(c.platformFee).to.equal(TOTAL_SUPPLY / 100n);
    expect(c.creatorEntitlement).to.equal(TOTAL_SUPPLY - TOTAL_SUPPLY / 100n);
    await expectLedger(f.manager, f.token, [f.bob]);
  });

  it("pays the creator exactly once; others and early claims are rejected without state change (T-S02..S04)", async function () {
    const f = await loadFixture(fundedFixture);
    const { id, deadline } = await createCampaign(f.manager, f.alice, { goal: KT(100) });
    await contribute(f.token, f.manager, f.bob, id, KT(120));
    await expect(f.manager.connect(f.alice).claimCreatorPayout(id)).to.be.revertedWithCustomError(f.manager, "NotFinalized");
    await time.increaseTo(deadline);
    await expect(f.manager.connect(f.alice).claimCreatorPayout(id)).to.be.revertedWithCustomError(f.manager, "NotFinalized");
    await f.manager.finalize(id);

    const before = await snapshot(f.manager, f.token, [f.alice, f.bob, f.owner]);
    for (const intruder of [f.bob, f.owner, f.carol]) {
      await expect(f.manager.connect(intruder).claimCreatorPayout(id)).to.be.revertedWithCustomError(f.manager, "NotCreator");
    }
    expect(await snapshot(f.manager, f.token, [f.alice, f.bob, f.owner])).to.deep.equal(before);

    const entitlement = KT(120) - KT(120) / 100n;
    await expect(f.manager.connect(f.alice).claimCreatorPayout(id))
      .to.emit(f.manager, "CreatorPaid")
      .withArgs(id, f.alice.address, entitlement);
    const c = await f.manager.getCampaign(id);
    expect(c.creatorPaid).to.equal(true);
    expect(c.outstanding).to.equal(0n);

    const afterClaim = await snapshot(f.manager, f.token, [f.alice, f.bob, f.owner]);
    await expect(f.manager.connect(f.alice).claimCreatorPayout(id)).to.be.revertedWithCustomError(f.manager, "AlreadyClaimed");
    expect(await snapshot(f.manager, f.token, [f.alice, f.bob, f.owner])).to.deep.equal(afterClaim);
    await expect(f.manager.connect(f.bob).claimRefund(id)).to.be.revertedWithCustomError(f.manager, "NotFailed");
    await expectLedger(f.manager, f.token, [f.bob]);
  });

  it("accrues platform fees across campaigns; only the owner claims them, once (T-S05)", async function () {
    const f = await loadFixture(fundedFixture);
    await settled(f, { goal: KT(100), contributions: [[f.bob, KT(250)]] });
    await settled(f, { goal: KT(10), contributions: [[f.carol, 1999n]] }); // fails: 1999 base units < 10 KT
    await settled(f, { goal: 1999n, contributions: [[f.dave, 1999n]] });
    const expectedFees = KT(250) / 100n + 1999n / 100n;
    expect(await f.manager.platformFeesOutstanding()).to.equal(expectedFees);

    const beforeUnauthorized = await snapshot(f.manager, f.token, [f.alice, f.owner, f.bob, f.carol, f.dave]);
    await expect(f.manager.connect(f.alice).claimPlatformFees()).to.be.revertedWith(OWNABLE);
    expect(await snapshot(f.manager, f.token, [f.alice, f.owner, f.bob, f.carol, f.dave])).to.deep.equal(beforeUnauthorized);
    await expect(f.manager.connect(f.owner).claimPlatformFees())
      .to.emit(f.manager, "PlatformFeesClaimed")
      .withArgs(f.owner.address, expectedFees);
    expect(await f.manager.platformFeesOutstanding()).to.equal(0n);
    await expect(f.manager.connect(f.owner).claimPlatformFees()).to.be.revertedWithCustomError(f.manager, "NothingToClaim");
    await expectLedger(f.manager, f.token, [f.bob, f.carol, f.dave]);
  });
});

describe("CampaignManager: failed campaigns", function () {
  it("refunds each contributor exactly their recorded total, once; no fee, no payout (T-R01..R05)", async function () {
    const f = await loadFixture(fundedFixture);
    const { id, deadline } = await createCampaign(f.manager, f.alice, { goal: KT(1000) });
    await contribute(f.token, f.manager, f.bob, id, KT(100));
    await contribute(f.token, f.manager, f.carol, id, KT(50));
    await contribute(f.token, f.manager, f.bob, id, KT(25));
    await expect(f.manager.connect(f.bob).claimRefund(id)).to.be.revertedWithCustomError(f.manager, "NotFinalized");
    await time.increaseTo(deadline);
    await f.manager.finalize(id);
    expect(await f.manager.platformFeesOutstanding()).to.equal(0n);
    await expect(f.manager.connect(f.alice).claimCreatorPayout(id)).to.be.revertedWithCustomError(f.manager, "NotSuccessful");

    await expect(f.manager.connect(f.bob).claimRefund(id))
      .to.emit(f.manager, "Refunded")
      .withArgs(id, f.bob.address, KT(125));
    expect(await f.manager.refundClaimed(id, f.bob.address)).to.equal(true);
    expect(await f.manager.contributionOf(id, f.bob.address)).to.equal(KT(125)); // record kept
    await expectLedger(f.manager, f.token, [f.bob, f.carol]);

    const before = await snapshot(f.manager, f.token, [f.bob, f.carol, f.dave]);
    await expect(f.manager.connect(f.bob).claimRefund(id)).to.be.revertedWithCustomError(f.manager, "AlreadyClaimed");
    await expect(f.manager.connect(f.dave).claimRefund(id)).to.be.revertedWithCustomError(f.manager, "NothingToClaim");
    expect(await snapshot(f.manager, f.token, [f.bob, f.carol, f.dave])).to.deep.equal(before);

    await expect(f.manager.connect(f.carol).claimRefund(id)).to.changeTokenBalances(
      f.token,
      [f.carol, f.manager],
      [KT(50), -KT(50)]
    );
    expect((await f.manager.getCampaign(id)).outstanding).to.equal(0n);
    await expectLedger(f.manager, f.token, [f.bob, f.carol]);
  });

  it("lets an owner who contributed reclaim only their own refund (T-A04)", async function () {
    const f = await loadFixture(fundedFixture);
    const id = await settled(f, { goal: KT(1000), contributions: [[f.owner, KT(10)], [f.bob, KT(20)]] });
    await expect(f.manager.connect(f.owner).claimRefund(id)).to.changeTokenBalance(f.token, f.owner, KT(10));
    await expect(f.manager.connect(f.owner).claimRefund(id)).to.be.revertedWithCustomError(f.manager, "AlreadyClaimed");
    expect(await f.manager.refundClaimed(id, f.bob.address)).to.equal(false);
    await expectLedger(f.manager, f.token, [f.owner, f.bob]);
  });
});

describe("CampaignManager: isolation and unsolicited KT", function () {
  it("keeps simultaneous campaigns isolated across lifecycle states (T-I08, I1)", async function () {
    const f = await loadFixture(fundedFixture);
    const actors = [f.bob, f.carol, f.dave];
    const a = await createCampaign(f.manager, f.alice, { goal: KT(100), duration: 600n });
    const b = await createCampaign(f.manager, f.bob, { goal: KT(500), duration: 600n });
    const c = await createCampaign(f.manager, f.carol, { goal: KT(50), duration: 7200n });
    await contribute(f.token, f.manager, f.bob, a.id, KT(100));
    await contribute(f.token, f.manager, f.carol, b.id, KT(60));
    await contribute(f.token, f.manager, f.dave, c.id, KT(40));
    await time.increaseTo(a.deadline);
    await f.manager.finalize(a.id); // Successful
    await f.manager.finalize(b.id); // Failed
    const cBefore = plainCampaign(await f.manager.getCampaign(c.id));
    const bBefore = plainCampaign(await f.manager.getCampaign(b.id));

    await f.manager.connect(f.alice).claimCreatorPayout(a.id);
    expect(plainCampaign(await f.manager.getCampaign(b.id))).to.deep.equal(bBefore);
    expect(plainCampaign(await f.manager.getCampaign(c.id))).to.deep.equal(cBefore);
    await f.manager.connect(f.carol).claimRefund(b.id);
    expect(plainCampaign(await f.manager.getCampaign(c.id))).to.deep.equal(cBefore);
    expect(await f.manager.contributionOf(c.id, f.dave.address)).to.equal(KT(40));
    await expectLedger(f.manager, f.token, actors);

    // Conservation per campaign: T = paid out + outstanding + fee (I1)
    const ca = await f.manager.getCampaign(a.id);
    expect(ca.creatorEntitlement + ca.platformFee + ca.outstanding).to.equal(ca.totalContributed);
    const cb = await f.manager.getCampaign(b.id);
    expect(KT(60) /* refunded */ + cb.outstanding).to.equal(cb.totalContributed);
  });

  it("never credits unsolicited KT to contributions, outcomes, fees or entitlements (T-I04)", async function () {
    const f = await loadFixture(fundedFixture);
    const managerAddr = await f.manager.getAddress();
    const { id, deadline } = await createCampaign(f.manager, f.alice, { goal: KT(100) });
    await contribute(f.token, f.manager, f.bob, id, KT(60));
    await f.token.connect(f.carol).transfer(managerAddr, KT(500)); // far above the goal
    expect((await f.manager.getCampaign(id)).totalContributed).to.equal(KT(60));
    expect(await f.manager.contributionOf(id, f.carol.address)).to.equal(0n);
    await expectLedger(f.manager, f.token, [f.bob, f.carol], KT(500));

    await time.increaseTo(deadline);
    await f.manager.finalize(id);
    expect((await f.manager.getCampaign(id)).status).to.equal(Status.Failed); // outcome unchanged
    expect(await f.manager.platformFeesOutstanding()).to.equal(0n);
    await expect(f.manager.connect(f.carol).claimRefund(id)).to.be.revertedWithCustomError(f.manager, "NothingToClaim");
    await f.manager.connect(f.bob).claimRefund(id);
    await expectLedger(f.manager, f.token, [f.bob, f.carol], KT(500));

    // A successful campaign's fee and entitlement are unaffected by excess
    const id2 = await settled(f, { goal: KT(10), contributions: [[f.dave, KT(10)]] });
    expect((await f.manager.getCampaign(id2)).creatorEntitlement).to.equal(KT(10) - KT(10) / 100n);
    expect(await f.manager.platformFeesOutstanding()).to.equal(KT(10) / 100n);
    await expectLedger(f.manager, f.token, [f.bob, f.carol, f.dave], KT(500));
  });
});

describe("CampaignManager: ownership", function () {
  it("disables renunciation", async function () {
    const f = await loadFixture(fundedFixture);
    await expect(f.manager.connect(f.owner).renounceOwnership()).to.be.revertedWithCustomError(f.manager, "RenounceDisabled");
    expect(await f.manager.owner()).to.equal(f.owner.address);
  });

  it("moves authority over accrued, unclaimed fees to the accepted new owner (T-A03, T-A05)", async function () {
    const f = await loadFixture(fundedFixture);
    await settled(f, { goal: KT(100), contributions: [[f.bob, KT(300)]] });
    const fees = KT(3);
    expect(await f.manager.platformFeesOutstanding()).to.equal(fees);
    const ledger = await f.manager.totalOutstanding();

    await f.manager.connect(f.owner).transferOwnership(f.dave.address);
    await expect(f.manager.connect(f.dave).claimPlatformFees()).to.be.revertedWith(OWNABLE); // pending only
    await f.manager.connect(f.dave).acceptOwnership();
    expect(await f.manager.totalOutstanding()).to.equal(ledger); // transfer changes no amounts
    await expect(f.manager.connect(f.owner).claimPlatformFees()).to.be.revertedWith(OWNABLE);
    await expect(f.manager.connect(f.dave).claimPlatformFees()).to.changeTokenBalance(f.token, f.dave, fees);
  });
});
