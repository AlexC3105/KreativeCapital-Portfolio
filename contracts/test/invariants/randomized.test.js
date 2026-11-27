// T-Z01: seeded randomized operation sequences checked against an independent reference
// model after EVERY operation, including expected reverts. Minimum: 20 seeds x 200
// operations. Override with KC_FUZZ_SEEDS / KC_FUZZ_STEPS for exploratory runs only.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { KT, deploySystemFixture, buyKT } = require("../helpers/fixtures");
const { Model, rng, SUPPLY } = require("../helpers/model");

const SEED_COUNT = Number(process.env.KC_FUZZ_SEEDS || 20);
const STEPS = Number(process.env.KC_FUZZ_STEPS || 200);
const SEEDS = Array.from({ length: SEED_COUNT }, (_, i) => 1000 + i * 7919); // recorded, reproducible
const GAS = { gasLimit: require("hardhat").__SOLIDITY_COVERAGE_RUNNING ? 25_000_000 : 1_000_000 }; // see helpers/manager.js
const MAX_CAMPAIGNS = 40;
const summary = [];

async function systemWithActors() {
  const f = await deploySystemFixture();
  const actors = [f.owner, f.alice, f.bob, f.carol, f.dave, f.erin];
  for (const a of actors) await buyKT(f.token, a, KT(5_000));
  return { ...f, actors };
}

/** Send a tx at an exact timestamp (model.now + 1) and check it matches the prediction. */
async function exec(model, contract, prediction, send) {
  model.now += 1n;
  await time.setNextBlockTimestamp(model.now);
  const p = send();
  if (prediction.error) {
    if (prediction.string) await expect(p).to.be.revertedWith(prediction.error);
    else await expect(p).to.be.revertedWithCustomError(contract, prediction.error);
    return false;
  }
  await (await p).wait();
  prediction.apply();
  return true;
}

async function checkInvariants(f, model, touched) {
  const managerAddr = await f.manager.getAddress();
  const tokenAddr = await f.token.getAddress();
  const L = model.liabilities();
  const [count, fees, outstanding, balance, excess, solvent, shortfall, supply, reserve, tokenHeld] = await Promise.all([
    f.manager.campaignCount(),
    f.manager.platformFeesOutstanding(),
    f.manager.totalOutstanding(),
    f.token.balanceOf(managerAddr),
    f.manager.excessBalance(),
    f.manager.isSolvent(),
    f.manager.shortfall(),
    f.token.totalSupply(),
    f.token.saleReserve(),
    f.token.balanceOf(tokenAddr),
  ]);
  expect(count).to.equal(BigInt(model.campaigns.length));
  expect(fees, "platform fees").to.equal(model.fees);
  expect(outstanding, "I2 totalOutstanding == model L").to.equal(L);
  expect(balance, "manager balance").to.equal(model.managerBalance);
  expect(balance, "I3/I4 balance == L + excess").to.equal(L + model.excess);
  expect(excess, "I4 excess").to.equal(model.excess);
  expect(solvent, "solvent").to.equal(true);
  expect(shortfall).to.equal(0n);
  expect(supply, "I9 supply").to.equal(SUPPLY);
  expect(reserve).to.equal(model.saleReserve);
  expect(tokenHeld, "I9 reserve custody").to.equal(model.saleReserve);

  const balances = await Promise.all(f.actors.map((a) => f.token.balanceOf(a.address)));
  let held = model.saleReserve + balance;
  f.actors.forEach((a, i) => {
    expect(balances[i], `balance ${a.address}`).to.equal(model.balances.get(a.address));
    held += balances[i];
  });
  expect(held, "I9 reserve + balances == supply").to.equal(SUPPLY);

  // I1, I5-I8: every campaign's on-chain record equals the model (untouched ones unchanged).
  for (let first = 1; first <= model.campaigns.length; first += 50) {
    const page = await f.manager.getCampaigns(first, 50);
    page.forEach((c, i) => {
      const m = model.campaigns[first - 1 + i];
      expect(c.creator).to.equal(m.creator);
      expect(c.goal).to.equal(m.goal);
      expect(c.deadline).to.equal(m.deadline);
      expect(c.status, `status ${m.id}`).to.equal(m.status);
      expect(c.totalContributed, `I5 total ${m.id}`).to.equal(m.total);
      expect(c.platformFee, `I6 fee ${m.id}`).to.equal(m.fee);
      expect(c.creatorEntitlement).to.equal(m.entitlement);
      expect(c.creatorPaid).to.equal(m.creatorPaid);
      expect(c.outstanding, `outstanding ${m.id}`).to.equal(m.outstanding);
      // I1 conservation: T = paid out + outstanding + fee
      expect(m.paidOut + m.outstanding + m.fee, `I1 ${m.id}`).to.equal(m.total);
      if (m.status === 1n) expect(m.entitlement + m.fee).to.equal(m.total);
    });
  }
  if (touched) {
    const m = model.get(touched);
    if (m) {
      const [contribs, refunds] = await Promise.all([
        Promise.all(f.actors.map((a) => f.manager.contributionOf(touched, a.address))),
        Promise.all(f.actors.map((a) => f.manager.refundClaimed(touched, a.address))),
      ]);
      f.actors.forEach((a, i) => {
        expect(contribs[i]).to.equal(m.contrib.get(a.address) || 0n);
        expect(refunds[i]).to.equal(m.refunded.has(a.address));
      });
    }
  }
}

function randomGoal(r) {
  return r.pick([
    1n, 99n, 100n, 101n, 199n,
    KT(r.int(1, 50)), KT(r.int(1, 300)), KT(r.int(1, 300)) + BigInt(r.int(0, 99)),
    KT(r.int(300, 2000)), 0n, SUPPLY + 1n,
  ]);
}

// Targeted selectors (about 60% of the time) steer operations toward eligible states so that
// successful settlement paths are exercised; the remainder stays uniformly random/invalid.
function targetId(r, model, predicate) {
  const ids = model.campaigns.filter(predicate).map((c) => c.id);
  return ids.length && r.chance(0.6) ? r.pick(ids) : randomId(r, model);
}

function randomId(r, model) {
  const n = model.campaigns.length;
  if (n === 0 || r.chance(0.08)) return r.pick([0n, BigInt(n + 1)]);
  return BigInt(r.int(1, n));
}

describe(`Randomized reference-model invariants (T-Z01: ${SEED_COUNT} seeds x ${STEPS} operations)`, function () {
  this.timeout(0);

  after(function () {
    console.log("\n    T-Z01 seed summary (seed: operations / succeeded / expected reverts / campaigns / finalized)");
    for (const s of summary) {
      console.log(`      ${s.seed}: ${s.ops} / ${s.ok} / ${s.reverts} / ${s.campaigns} / ${s.finalized}`);
    }
    const total = summary.reduce((a, s) => a + s.ops, 0);
    const sum = (field) =>
      JSON.stringify(
        summary.reduce((acc, s) => {
          for (const [k, v] of Object.entries(s[field])) acc[k] = (acc[k] || 0) + v;
          return acc;
        }, {})
      );
    console.log(`    total operations: ${total}`);
    console.log(`    attempted by kind: ${sum("kinds")}`);
    console.log(`    succeeded by kind: ${sum("okKinds")}`);
  });

  for (const seed of SEEDS) {
    it(`seed ${seed}`, async function () {
      const f = await loadFixture(systemWithActors);
      const r = rng(seed);
      const balances = await Promise.all(f.actors.map(async (a) => [a.address, await f.token.balanceOf(a.address)]));
      const model = new Model({
        owner: f.owner.address,
        now: BigInt(await time.latest()),
        balances,
        saleReserve: await f.token.saleReserve(),
      });
      const managerAddr = await f.manager.getAddress();
      const stats = { seed, ops: 0, ok: 0, reverts: 0, kinds: {}, okKinds: {} };

      for (let step = 0; step < STEPS; step++) {
        const actor = r.pick(f.actors);
        const sender = actor.address;
        let kind = r.pick([
          "create", "create", "contribute", "contribute", "contribute", "contribute",
          "finalize", "finalize", "payout", "refund", "refund", "fees", "unsolicited", "warp", "warp", "buy",
        ]);
        if (kind === "create" && model.campaigns.length >= MAX_CAMPAIGNS) kind = "contribute";
        stats.kinds[kind] = (stats.kinds[kind] || 0) + 1;
        let ok = null;
        let touched = null;

        if (kind === "create") {
          const goal = randomGoal(r);
          const duration = BigInt(r.pick([r.int(60, 7200), r.int(60, 7200), 59, 60, r.int(7200, 86400)]));
          const name = r.pick(["A", "Same", "Campaign é", "", "x".repeat(65), "😀".repeat(16)]);
          ok = await exec(model, f.manager, model.predictCreate(sender, goal, duration, name, model.now + 1n), () =>
            f.manager.connect(actor).createCampaign(goal, duration, name, "", GAS)
          );
        } else if (kind === "contribute") {
          const id = targetId(r, model, (c) => c.status === 0n && model.now + 2n < c.deadline);
          const amount = r.pick([0n, 1n, BigInt(r.int(1, 1000)), KT(r.int(1, 300)), KT(r.int(1, 300)), KT(9_000)]);
          model.now += 1n; // approve tx (always succeeds)
          await time.setNextBlockTimestamp(model.now);
          await (await f.token.connect(actor).approve(managerAddr, amount)).wait();
          ok = await exec(model, f.manager, model.predictContribute(sender, id, amount, model.now + 1n), () =>
            f.manager.connect(actor).contribute(id, amount, GAS)
          );
          touched = id;
        } else if (kind === "finalize") {
          const id = targetId(r, model, (c) => c.status === 0n && model.now + 1n >= c.deadline);
          ok = await exec(model, f.manager, model.predictFinalize(id, model.now + 1n), () =>
            f.manager.connect(actor).finalize(id, GAS)
          );
          touched = id;
        } else if (kind === "payout") {
          const id = targetId(r, model, (c) => c.status === 1n && !c.creatorPaid);
          const who = r.chance(0.6) && model.get(id) ? f.actors.find((a) => a.address === model.get(id).creator) : actor;
          ok = await exec(model, f.manager, model.predictPayout(who.address, id), () =>
            f.manager.connect(who).claimCreatorPayout(id, GAS)
          );
          touched = id;
        } else if (kind === "refund") {
          const id = targetId(r, model, (c) => c.status === 2n && [...c.contrib.keys()].some((a) => !c.refunded.has(a)));
          const m = model.get(id);
          const eligible = m && m.status === 2n ? [...m.contrib.keys()].filter((a) => !m.refunded.has(a)) : [];
          const chosen = eligible.length && r.chance(0.7) ? r.pick(eligible) : null;
          const who = chosen ? f.actors.find((a) => a.address === chosen) : actor;
          ok = await exec(model, f.manager, model.predictRefund(who.address, id), () => f.manager.connect(who).claimRefund(id, GAS));
          touched = id;
        } else if (kind === "fees") {
          const who = r.chance(0.6) ? f.owner : actor;
          ok = await exec(model, f.manager, model.predictFeeClaim(who.address), () => f.manager.connect(who).claimPlatformFees(GAS));
        } else if (kind === "unsolicited") {
          const amount = r.pick([1n, KT(r.int(1, 50)), KT(9_000)]);
          ok = await exec(model, f.token, model.predictUnsolicited(sender, amount), () =>
            f.token.connect(actor).transfer(managerAddr, amount, GAS)
          );
        } else if (kind === "warp") {
          model.now += BigInt(r.pick([r.int(1, 600), r.int(600, 3600), r.int(3600, 7200)]));
        } else if (kind === "buy") {
          const value = r.pick([0n, 1n, BigInt(r.int(1, 10 ** 9)), ethers.parseEther(String(r.int(1, 5)))]);
          ok = await exec(model, f.token, model.predictBuy(sender, value), () => f.token.connect(actor).buyTokens({ value, ...GAS }));
        }

        stats.ops += 1;
        if (ok === true) {
          stats.ok += 1;
          stats.okKinds[kind] = (stats.okKinds[kind] || 0) + 1;
        }
        if (ok === false) stats.reverts += 1;
        await checkInvariants(f, model, touched);
      }
      stats.campaigns = model.campaigns.length;
      stats.finalized = model.campaigns.filter((c) => c.status !== 0n).length;
      summary.push(stats);
      expect(stats.ops).to.equal(STEPS);
    });
  }
});
