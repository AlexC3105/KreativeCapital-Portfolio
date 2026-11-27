// Read layer over the verified deployment (read RPC only; never the wallet).
import { Contract } from "ethers";

export const PAGE_SIZE = 6;
export const Phase = Object.freeze({ Open: 0, AwaitingFinalization: 1, Successful: 2, Failed: 3 });
export const PHASE_LABELS = ["Open", "Awaiting finalization", "Successful", "Failed"];
export const Status = Object.freeze({ Active: 0, Successful: 1, Failed: 2 });

function toCampaign(id, c, now) {
  const status = Number(c.status);
  let phase;
  if (status === Status.Successful) phase = Phase.Successful;
  else if (status === Status.Failed) phase = Phase.Failed;
  else phase = BigInt(now) < c.deadline ? Phase.Open : Phase.AwaitingFinalization;
  return {
    id: BigInt(id),
    creator: c.creator,
    createdAt: c.createdAt,
    deadline: c.deadline,
    status,
    phase,
    creatorPaid: c.creatorPaid,
    goal: c.goal,
    totalContributed: c.totalContributed,
    platformFee: c.platformFee,
    creatorEntitlement: c.creatorEntitlement,
    outstanding: c.outstanding,
    name: c.name,
    description: c.description,
  };
}

export function createApi({ provider, manifest, artifacts }) {
  const token = new Contract(manifest.contracts.KreativeToken.address, artifacts.KreativeToken.abi, provider);
  const manager = new Contract(manifest.contracts.CampaignManager.address, artifacts.CampaignManager.abi, provider);
  const managerAddress = manifest.contracts.CampaignManager.address;

  /** Chain time (latest block timestamp); phases use chain time, not the browser clock. */
  async function chainTime() {
    const block = await provider.getBlock("latest");
    return BigInt(block.timestamp);
  }

  async function allCampaigns() {
    const count = await manager.campaignCount();
    const now = await chainTime();
    const out = [];
    for (let first = 1n; first <= count; first += 50n) {
      const page = await manager.getCampaigns(first, 50n);
      page.forEach((c, i) => out.push(toCampaign(first + BigInt(i), c, now)));
    }
    return { campaigns: out, now };
  }

  return {
    provider,
    token,
    manager,
    managerAddress,
    tokenAddress: manifest.contracts.KreativeToken.address,
    genesisHash: manifest.genesisHash,
    chainTime,

    /** Newest-first page of campaigns (page 0 = newest), using bounded getCampaigns calls. */
    async getCampaignPage(page, size = PAGE_SIZE) {
      const count = await manager.campaignCount();
      const now = await chainTime();
      const last = count - BigInt(page) * BigInt(size);
      if (last < 1n) return { campaigns: [], count, now };
      const first = last - BigInt(size) + 1n > 0n ? last - BigInt(size) + 1n : 1n;
      const rows = await manager.getCampaigns(first, last - first + 1n);
      const campaigns = rows.map((c, i) => toCampaign(first + BigInt(i), c, now)).reverse();
      return { campaigns, count, now };
    },

    async getCampaign(id, account) {
      const count = await manager.campaignCount();
      if (BigInt(id) < 1n || BigInt(id) > count) return null;
      const now = await chainTime();
      const campaign = toCampaign(id, await manager.getCampaign(id), now);
      let me = null;
      if (account) {
        const [contribution, refunded, balance, allowance] = await Promise.all([
          manager.contributionOf(id, account),
          manager.refundClaimed(id, account),
          token.balanceOf(account),
          token.allowance(account, managerAddress),
        ]);
        me = { contribution, refunded, balance, allowance };
      }
      return { campaign, me, now };
    },

    async getPlatform() {
      const [
        tokenBalance, totalOutstanding, isSolvent, excessBalance, shortfall, platformFeesOutstanding, managerOwner,
        managerPendingOwner, campaignCount, totalSupply, saleReserve, tokensSold, totalProceeds, proceedsWithdrawn,
        unwithdrawnProceeds, unsolicitedTokenBalance, unsolicitedEthBalance, tokenOwner, tokenPendingOwner,
      ] = await Promise.all([
        manager.tokenBalance(), manager.totalOutstanding(), manager.isSolvent(), manager.excessBalance(),
        manager.shortfall(), manager.platformFeesOutstanding(), manager.owner(), manager.pendingOwner(),
        manager.campaignCount(), token.totalSupply(), token.saleReserve(), token.tokensSold(), token.totalProceeds(),
        token.proceedsWithdrawn(), token.unwithdrawnProceeds(), token.unsolicitedTokenBalance(),
        token.unsolicitedEthBalance(), token.owner(), token.pendingOwner(),
      ]);
      return {
        manager: { tokenBalance, totalOutstanding, isSolvent, excessBalance, shortfall, platformFeesOutstanding, owner: managerOwner, pendingOwner: managerPendingOwner, campaignCount },
        token: { totalSupply, saleReserve, tokensSold, totalProceeds, proceedsWithdrawn, unwithdrawnProceeds, unsolicitedTokenBalance, unsolicitedEthBalance, owner: tokenOwner, pendingOwner: tokenPendingOwner },
      };
    },

    async getAccount(account) {
      const [eth, kt, allowance, managerOwner, tokenOwner, fees, unwithdrawn] = await Promise.all([
        provider.getBalance(account),
        token.balanceOf(account),
        token.allowance(account, managerAddress),
        manager.owner(),
        token.owner(),
        manager.platformFeesOutstanding(),
        token.unwithdrawnProceeds(),
      ]);
      const { campaigns, now } = await allCampaigns();
      const created = campaigns.filter((c) => c.creator === account);
      const contributions = [];
      for (const c of campaigns) {
        const amount = await manager.contributionOf(c.id, account);
        if (amount > 0n) contributions.push({ campaign: c, amount, refunded: await manager.refundClaimed(c.id, account) });
      }
      return {
        account,
        eth,
        kt,
        allowance,
        now,
        created,
        contributions,
        payouts: created.filter((c) => c.status === Status.Successful && !c.creatorPaid),
        refunds: contributions.filter((x) => x.campaign.status === Status.Failed && !x.refunded),
        isManagerOwner: managerOwner === account,
        isTokenOwner: tokenOwner === account,
        platformFeesOutstanding: fees,
        unwithdrawnProceeds: unwithdrawn,
      };
    },
  };
}
