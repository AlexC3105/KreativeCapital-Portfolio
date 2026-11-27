// Boundary/stress cases and explicit deterministic invariant walkthroughs
// (T-B01, T-B03, T-I01, T-I02, T-I03, T-I05).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { KT, deploySystemFixture, buyKT, contribute } = require("../helpers/fixtures");
const { createCampaign, expectLedger, computeLiabilities } = require("../helpers/manager");

describe("CampaignManager: boundaries and explicit invariants", function () {
  it("handles 1-base-unit contributions, a zero fee and 1-unit refunds (T-B01)", async function () {
    const f = await loadFixture(deploySystemFixture);
    const actors = [f.alice, f.bob, f.carol];
    for (const a of actors) await buyKT(f.token, a, 100n); // 1 wei buys 100 base units
    const ok = await createCampaign(f.manager, f.alice, { goal: 2n });
    const ko = await createCampaign(f.manager, f.alice, { goal: 5n });
    await contribute(f.token, f.manager, f.bob, ok.id, 1n);
    await contribute(f.token, f.manager, f.carol, ok.id, 1n);
    await contribute(f.token, f.manager, f.bob, ko.id, 1n);
    await time.increaseTo(ko.deadline);
    await f.manager.finalize(ok.id);
    await f.manager.finalize(ko.id);
    const c = await f.manager.getCampaign(ok.id);
    expect(c.platformFee).to.equal(0n); // floor(2 / 100) = 0
    expect(c.creatorEntitlement).to.equal(2n);
    await expect(f.manager.connect(f.alice).claimCreatorPayout(ok.id)).to.changeTokenBalance(f.token, f.alice, 2n);
    await expect(f.manager.connect(f.bob).claimRefund(ko.id)).to.changeTokenBalance(f.token, f.bob, 1n);
    await expectLedger(f.manager, f.token, actors);
    expect(await f.manager.totalOutstanding()).to.equal(0n);
  });

  it("supports 51 campaigns with bounded pagination and 19 contributors on one campaign (T-B03)", async function () {
    const f = await loadFixture(deploySystemFixture);
    const signers = await ethers.getSigners();
    const contributors = signers.slice(1, 20); // 19 accounts
    for (let i = 0; i < 51; i++) await createCampaign(f.manager, f.alice, { goal: KT(1_000_000), name: `c${i + 1}` });
    expect(await f.manager.campaignCount()).to.equal(51n);
    const page1 = await f.manager.getCampaigns(1n, 50n);
    expect(page1).to.have.lengthOf(50);
    expect(page1[49].name).to.equal("c50");
    const page2 = await f.manager.getCampaigns(51n, 50n);
    expect(page2.map((c) => c.name)).to.deep.equal(["c51"]);

    const target = 7n;
    for (const [i, s] of contributors.entries()) {
      await buyKT(f.token, s, KT(10));
      await contribute(f.token, f.manager, s, target, KT(1) + BigInt(i));
    }
    const deadline = (await f.manager.getCampaign(51n)).deadline;
    await time.increaseTo(deadline);
    await f.manager.finalize(target); // far below goal -> Failed
    for (const [i, s] of contributors.entries()) {
      await expect(f.manager.connect(s).claimRefund(target)).to.changeTokenBalance(f.token, s, KT(1) + BigInt(i));
    }
    expect((await f.manager.getCampaign(target)).outstanding).to.equal(0n);
    await expectLedger(f.manager, f.token, contributors);
  });

  it("walks every lifecycle state asserting conservation, ledger, solvency and totals (T-I01, T-I02, T-I03, T-I05)", async function () {
    const f = await loadFixture(deploySystemFixture);
    const actors = [f.owner, f.alice, f.bob, f.carol];
    for (const a of actors) await buyKT(f.token, a, KT(1_000));
    const managerAddr = await f.manager.getAddress();

    async function check(ids, paidOut) {
      // I2: stored ledger == independent formula; I3: balance == ledger (no excess)
      expect(await f.manager.totalOutstanding()).to.equal(await computeLiabilities(f.manager, actors));
      expect(await f.token.balanceOf(managerAddr)).to.equal(await f.manager.totalOutstanding());
      expect(await f.manager.isSolvent()).to.equal(true);
      for (const id of ids) {
        const c = await f.manager.getCampaign(id);
        // I5: total == sum of recorded contributions
        let sum = 0n;
        for (const a of actors) sum += await f.manager.contributionOf(id, a.address);
        expect(c.totalContributed, `I5 campaign ${id}`).to.equal(sum);
        // I1: T = paid out + outstanding + fee
        expect(paidOut[id] + c.outstanding + c.platformFee, `I1 campaign ${id}`).to.equal(c.totalContributed);
      }
    }

    const s = await createCampaign(f.manager, f.alice, { goal: KT(100), duration: 600n });
    const x = await createCampaign(f.manager, f.bob, { goal: KT(100), duration: 600n });
    const paid = { [s.id]: 0n, [x.id]: 0n };
    await check([s.id, x.id], paid);
    await contribute(f.token, f.manager, f.bob, s.id, KT(70));
    await contribute(f.token, f.manager, f.carol, s.id, KT(31) + 7n);
    await contribute(f.token, f.manager, f.alice, x.id, KT(40));
    await contribute(f.token, f.manager, f.owner, x.id, KT(9));
    await check([s.id, x.id], paid); // Active
    await time.increaseTo(s.deadline);
    await f.manager.finalize(s.id);
    await f.manager.finalize(x.id);
    await check([s.id, x.id], paid); // Successful / Failed, nothing paid yet
    const entitlement = (await f.manager.getCampaign(s.id)).creatorEntitlement;
    await f.manager.connect(f.alice).claimCreatorPayout(s.id);
    paid[s.id] += entitlement;
    await check([s.id, x.id], paid);
    await f.manager.connect(f.alice).claimRefund(x.id);
    paid[x.id] += KT(40);
    await check([s.id, x.id], paid);
    await f.manager.connect(f.owner).claimRefund(x.id);
    paid[x.id] += KT(9);
    await check([s.id, x.id], paid);
    const fee = await f.manager.platformFeesOutstanding();
    await f.manager.connect(f.owner).claimPlatformFees();
    await check([s.id, x.id], paid); // fee left the global pool; I1 still counts it once
    expect(fee).to.equal((KT(101) + 7n) / 100n);
    expect(await f.manager.totalOutstanding()).to.equal(0n);
  });
});
