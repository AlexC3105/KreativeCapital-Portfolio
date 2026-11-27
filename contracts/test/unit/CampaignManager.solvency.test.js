// Deterministic solvency guard (rules R-G1..R-G6).
// Insolvency is unreachable through the public interface; it is simulated here ONLY via
// hardhat_setStorageAt on the token balance slot (see helpers/manager.js).
const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { KT, deploySystemFixture, buyKT, contribute } = require("../helpers/fixtures");
const { Status, createCampaign, snapshot, setTokenBalanceUnsafe, expectLedger } = require("../helpers/manager");

/**
 * Three campaigns: S (Successful, unpaid), F (Failed, unrefunded), A (Active, open).
 * Liabilities L = C_S + fee_S + R_F + E_A.
 */
async function insolvencyFixture() {
  const f = await deploySystemFixture();
  for (const s of [f.owner, f.alice, f.bob, f.carol, f.dave]) await buyKT(f.token, s, KT(10_000));
  const S = await createCampaign(f.manager, f.alice, { goal: KT(100), duration: 600n });
  const F = await createCampaign(f.manager, f.bob, { goal: KT(1000), duration: 600n });
  const A = await createCampaign(f.manager, f.carol, { goal: KT(10), duration: 86400n });
  await contribute(f.token, f.manager, f.bob, S.id, KT(200));
  await contribute(f.token, f.manager, f.carol, F.id, KT(40));
  await contribute(f.token, f.manager, f.dave, A.id, KT(5));
  await time.increaseTo(S.deadline);
  await f.manager.finalize(S.id);
  await f.manager.finalize(F.id);
  return { ...f, S: S.id, F: F.id, A: A.id, actors: [f.owner, f.alice, f.bob, f.carol, f.dave] };
}

async function makeInsolvent(f, shortBy) {
  const managerAddr = await f.manager.getAddress();
  const L = await f.manager.totalOutstanding();
  await setTokenBalanceUnsafe(f.token, managerAddr, L - shortBy);
  return L;
}

describe("CampaignManager: solvency guard", function () {
  it("starts solvent with exact backing (precondition)", async function () {
    const f = await loadFixture(insolvencyFixture);
    const L = await f.manager.totalOutstanding();
    expect(L).to.equal(KT(200) + KT(40) + KT(5)); // C_S + fee_S + R_F + E_A
    await expectLedger(f.manager, f.token, f.actors);
  });

  it("reports liabilities, balance, solvency, excess and shortfall without reverting (T-G03)", async function () {
    const f = await loadFixture(insolvencyFixture);
    const L = await makeInsolvent(f, KT(1));
    expect(await f.manager.totalOutstanding()).to.equal(L);
    expect(await f.manager.tokenBalance()).to.equal(L - KT(1));
    expect(await f.manager.isSolvent()).to.equal(false);
    expect(await f.manager.excessBalance()).to.equal(0n);
    expect(await f.manager.shortfall()).to.equal(KT(1));
  });

  it("blocks every outgoing claim with Insolvent(B, L) and leaves all records unchanged (T-G01)", async function () {
    const f = await loadFixture(insolvencyFixture);
    const L = await makeInsolvent(f, 1n);
    const B = L - 1n;
    const before = await snapshot(f.manager, f.token, f.actors);
    await expect(f.manager.connect(f.alice).claimCreatorPayout(f.S))
      .to.be.revertedWithCustomError(f.manager, "Insolvent")
      .withArgs(B, L);
    await expect(f.manager.connect(f.carol).claimRefund(f.F))
      .to.be.revertedWithCustomError(f.manager, "Insolvent")
      .withArgs(B, L);
    await expect(f.manager.connect(f.owner).claimPlatformFees())
      .to.be.revertedWithCustomError(f.manager, "Insolvent")
      .withArgs(B, L);
    expect(await snapshot(f.manager, f.token, f.actors)).to.deep.equal(before);
  });

  it("rejects contributions while insolvent (T-G02)", async function () {
    const f = await loadFixture(insolvencyFixture);
    const L = await makeInsolvent(f, KT(2));
    await f.token.connect(f.bob).approve(await f.manager.getAddress(), KT(1));
    const before = await snapshot(f.manager, f.token, f.actors);
    await expect(f.manager.connect(f.bob).contribute(f.A, KT(1)))
      .to.be.revertedWithCustomError(f.manager, "Insolvent")
      .withArgs(L - KT(2), L);
    expect(await snapshot(f.manager, f.token, f.actors)).to.deep.equal(before);
  });

  it("keeps createCampaign and accounting-only finalization available while insolvent (T-G03)", async function () {
    const f = await loadFixture(insolvencyFixture);
    const L = await makeInsolvent(f, KT(1));
    const { id } = await createCampaign(f.manager, f.alice, { goal: KT(1), duration: 60n });
    expect(id).to.equal(4n);
    const deadline = (await f.manager.getCampaign(f.A)).deadline;
    await time.increaseTo(deadline);
    await f.manager.finalize(f.A); // A: 5 KT >= 10 KT goal? no -> Failed
    expect((await f.manager.getCampaign(f.A)).status).to.equal(Status.Failed);
    expect(await f.manager.totalOutstanding()).to.equal(L); // accounting transition only
    expect(await f.manager.isSolvent()).to.equal(false);
  });

  it("reports specific errors before the guard for ineligible callers (T-G06)", async function () {
    const f = await loadFixture(insolvencyFixture);
    await makeInsolvent(f, KT(1));
    await expect(f.manager.connect(f.bob).claimCreatorPayout(f.S)).to.be.revertedWithCustomError(f.manager, "NotCreator");
    await expect(f.manager.connect(f.dave).claimRefund(f.F)).to.be.revertedWithCustomError(f.manager, "NothingToClaim");
    await expect(f.manager.connect(f.alice).claimRefund(f.S)).to.be.revertedWithCustomError(f.manager, "NotFailed");
    await expect(f.manager.connect(f.alice).claimPlatformFees()).to.be.revertedWith("Ownable: caller is not the owner");
    await expect(f.manager.connect(f.bob).contribute(f.A, 0n)).to.be.revertedWithCustomError(f.manager, "ZeroAmount");
  });

  it("stays blocked after partial restoration and resumes automatically at exact restoration (T-G04)", async function () {
    const f = await loadFixture(insolvencyFixture);
    const managerAddr = await f.manager.getAddress();
    const L = await makeInsolvent(f, KT(3));
    const recordsBefore = await snapshot(f.manager, f.token, f.actors);

    await f.token.connect(f.dave).transfer(managerAddr, KT(2)); // partial
    expect(await f.manager.shortfall()).to.equal(KT(1));
    await expect(f.manager.connect(f.carol).claimRefund(f.F)).to.be.revertedWithCustomError(f.manager, "Insolvent");

    await f.token.connect(f.dave).transfer(managerAddr, KT(1)); // exact
    expect(await f.manager.isSolvent()).to.equal(true);
    expect(await f.manager.shortfall()).to.equal(0n);
    expect(await f.manager.excessBalance()).to.equal(0n);
    // The restoring transfers created no contribution, fee or claim.
    const recordsAfter = await snapshot(f.manager, f.token, f.actors);
    expect(recordsAfter.campaigns).to.deep.equal(recordsBefore.campaigns);
    expect(recordsAfter.platformFeesOutstanding).to.equal(recordsBefore.platformFeesOutstanding);
    expect(recordsAfter.totalOutstanding).to.equal(L);

    await expect(f.manager.connect(f.carol).claimRefund(f.F)).to.changeTokenBalance(f.token, f.carol, KT(40));
    await f.manager.connect(f.alice).claimCreatorPayout(f.S);
    await f.manager.connect(f.owner).claimPlatformFees();
    await contribute(f.token, f.manager, f.bob, f.A, KT(1));
    expect(await f.manager.isSolvent()).to.equal(true);
    expect(await f.manager.totalOutstanding()).to.equal(KT(6)); // A escrow: 5 + 1
    expect(await f.manager.tokenBalance()).to.equal(KT(6));
  });

  it("treats over-restoration as excess; outcomes, fees and entitlements unchanged (T-G05)", async function () {
    const f = await loadFixture(insolvencyFixture);
    const managerAddr = await f.manager.getAddress();
    await makeInsolvent(f, KT(3));
    const before = await snapshot(f.manager, f.token, f.actors);
    await f.token.connect(f.dave).transfer(managerAddr, KT(10));
    expect(await f.manager.excessBalance()).to.equal(KT(7));
    const after = await snapshot(f.manager, f.token, f.actors);
    expect(after.campaigns).to.deep.equal(before.campaigns);
    expect(after.platformFeesOutstanding).to.equal(before.platformFeesOutstanding);
    expect(after.totalOutstanding).to.equal(before.totalOutstanding);
  });
});
