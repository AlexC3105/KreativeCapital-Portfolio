// Independent reference accounting model for randomized testing (T-Z01).
// It implements the rules documented in docs/financial-model.md directly
// and predicts the outcome (including the expected custom error) of every operation.
const SUPPLY = 10n ** 24n;
const MIN_DURATION = 60n;
const MAX_DURATION = 365n * 24n * 3600n;

class Model {
  constructor({ owner, now, balances, saleReserve }) {
    this.owner = owner;
    this.now = now; // timestamp of the last mined block
    this.campaigns = []; // index = id - 1
    this.fees = 0n;
    this.managerBalance = 0n;
    this.excess = 0n; // unsolicited KT held by the manager
    this.balances = new Map(balances); // address -> KT
    this.saleReserve = saleReserve;
  }

  get(id) {
    return id >= 1n && id <= BigInt(this.campaigns.length) ? this.campaigns[Number(id) - 1] : null;
  }

  /** L per architecture §6.1, computed from model records. */
  liabilities() {
    let L = this.fees;
    for (const c of this.campaigns) {
      if (c.status === 0n) L += c.total;
      else if (c.status === 1n) L += c.creatorPaid ? 0n : c.entitlement;
      else for (const [a, v] of c.contrib) if (!c.refunded.has(a)) L += v;
    }
    return L;
  }

  // Each predict* returns { error } for an expected revert, or { apply } to mutate on success.
  predictCreate(sender, goal, duration, name, ts) {
    if (goal === 0n || goal > SUPPLY) return { error: "InvalidGoal" };
    if (duration < MIN_DURATION || duration > MAX_DURATION) return { error: "InvalidDuration" };
    const len = Buffer.byteLength(name, "utf8");
    if (len === 0 || len > 64) return { error: "InvalidName" };
    return {
      apply: () =>
        this.campaigns.push({
          id: BigInt(this.campaigns.length + 1),
          creator: sender,
          goal,
          deadline: ts + duration,
          status: 0n,
          total: 0n,
          fee: 0n,
          entitlement: 0n,
          creatorPaid: false,
          outstanding: 0n,
          paidOut: 0n,
          contrib: new Map(),
          refunded: new Set(),
        }),
    };
  }

  predictContribute(sender, id, amount, ts) {
    const c = this.get(id);
    if (!c) return { error: "UnknownCampaign" };
    if (c.status !== 0n || ts >= c.deadline) return { error: "CampaignEnded" };
    if (amount === 0n) return { error: "ZeroAmount" };
    if (this.managerBalance < this.liabilities()) return { error: "Insolvent" };
    if ((this.balances.get(sender) || 0n) < amount) return { error: "ERC20: transfer amount exceeds balance", string: true };
    return {
      apply: () => {
        c.contrib.set(sender, (c.contrib.get(sender) || 0n) + amount);
        c.total += amount;
        c.outstanding += amount;
        this.balances.set(sender, this.balances.get(sender) - amount);
        this.managerBalance += amount;
      },
    };
  }

  predictFinalize(id, ts) {
    const c = this.get(id);
    if (!c) return { error: "UnknownCampaign" };
    if (c.status !== 0n) return { error: "AlreadyFinalized" };
    if (ts < c.deadline) return { error: "CampaignNotEnded" };
    return {
      apply: () => {
        if (c.total >= c.goal) {
          c.status = 1n;
          c.fee = c.total / 100n;
          c.entitlement = c.total - c.fee;
          c.outstanding = c.entitlement;
          this.fees += c.fee;
        } else {
          c.status = 2n;
        }
      },
    };
  }

  predictPayout(sender, id) {
    const c = this.get(id);
    if (!c) return { error: "UnknownCampaign" };
    if (c.status === 0n) return { error: "NotFinalized" };
    if (c.status !== 1n) return { error: "NotSuccessful" };
    if (sender !== c.creator) return { error: "NotCreator" };
    if (c.creatorPaid) return { error: "AlreadyClaimed" };
    if (this.managerBalance < this.liabilities()) return { error: "Insolvent" };
    return {
      apply: () => {
        c.creatorPaid = true;
        c.outstanding -= c.entitlement;
        c.paidOut += c.entitlement;
        this.managerBalance -= c.entitlement;
        this.balances.set(sender, (this.balances.get(sender) || 0n) + c.entitlement);
      },
    };
  }

  predictRefund(sender, id) {
    const c = this.get(id);
    if (!c) return { error: "UnknownCampaign" };
    if (c.status === 0n) return { error: "NotFinalized" };
    if (c.status !== 2n) return { error: "NotFailed" };
    const amount = c.contrib.get(sender) || 0n;
    if (amount === 0n) return { error: "NothingToClaim" };
    if (c.refunded.has(sender)) return { error: "AlreadyClaimed" };
    if (this.managerBalance < this.liabilities()) return { error: "Insolvent" };
    return {
      apply: () => {
        c.refunded.add(sender);
        c.outstanding -= amount;
        c.paidOut += amount;
        this.managerBalance -= amount;
        this.balances.set(sender, (this.balances.get(sender) || 0n) + amount);
      },
    };
  }

  predictFeeClaim(sender) {
    if (sender !== this.owner) return { error: "Ownable: caller is not the owner", string: true };
    if (this.fees === 0n) return { error: "NothingToClaim" };
    if (this.managerBalance < this.liabilities()) return { error: "Insolvent" };
    return {
      apply: () => {
        const amount = this.fees;
        this.fees = 0n;
        this.managerBalance -= amount;
        this.balances.set(sender, (this.balances.get(sender) || 0n) + amount);
      },
    };
  }

  predictUnsolicited(sender, amount) {
    if ((this.balances.get(sender) || 0n) < amount) return { error: "ERC20: transfer amount exceeds balance", string: true };
    return {
      apply: () => {
        this.balances.set(sender, this.balances.get(sender) - amount);
        this.managerBalance += amount;
        this.excess += amount;
      },
    };
  }

  predictBuy(sender, value) {
    if (value === 0n) return { error: "ZeroPurchase" };
    const tokens = value * 100n;
    if (tokens > this.saleReserve) return { error: "InsufficientReserve" };
    return {
      apply: () => {
        this.saleReserve -= tokens;
        this.balances.set(sender, (this.balances.get(sender) || 0n) + tokens);
      },
    };
  }
}

/** Deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
  };
}

module.exports = { Model, rng, SUPPLY };
