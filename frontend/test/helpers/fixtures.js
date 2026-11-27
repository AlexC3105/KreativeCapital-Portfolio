import { createTxStore } from "../../src/state/txStore.js";
// Test-only fixtures and a fake app context for UI tests. Never imported by src/.
const H = (b) => "0x" + b.repeat(32);

export function sampleManifest() {
  return {
    schemaVersion: 2,
    network: "localhost",
    chainId: 31337,
    rpcUrl: "http://127.0.0.1:8545",
    genesisHash: H("01"),
    deployer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    accounts: [],
    compiler: { version: "0.8.24", optimizer: { enabled: false, runs: 200 }, evmVersion: "paris" },
    contracts: {
      KreativeToken: { address: "0x5FbDB2315678afecb367f032d93F642f64180aa3", deploymentTransaction: H("02"), blockNumber: 1, blockHash: H("03"), runtimeCodeHash: H("04") },
      CampaignManager: { address: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512", deploymentTransaction: H("05"), blockNumber: 2, blockHash: H("06"), runtimeCodeHash: H("07") },
    },
  };
}

export const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const BOB = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
export const KT = (n) => BigInt(n) * 10n ** 18n;

export function campaign(overrides = {}) {
  return {
    id: 1n, creator: ALICE, createdAt: 1000n, deadline: 5000n, status: 0, phase: 0, creatorPaid: false,
    goal: KT(100), totalContributed: KT(40), platformFee: 0n, creatorEntitlement: 0n, outstanding: KT(40),
    name: "Solar Garden", description: "Community project", ...overrides,
  };
}

export function platform({ solvent = true } = {}) {
  return {
    manager: {
      tokenBalance: solvent ? KT(40) : KT(30), totalOutstanding: KT(40), isSolvent: solvent, excessBalance: 0n,
      shortfall: solvent ? 0n : KT(10), platformFeesOutstanding: KT(1), owner: OWNER, pendingOwner: "0x0000000000000000000000000000000000000000", campaignCount: 1n,
    },
    token: {
      totalSupply: KT(1_000_000), saleReserve: KT(990_000), tokensSold: KT(10_000), totalProceeds: KT(100), proceedsWithdrawn: 0n,
      unwithdrawnProceeds: KT(100), unsolicitedTokenBalance: 0n, unsolicitedEthBalance: 0n, owner: OWNER, pendingOwner: "0x0000000000000000000000000000000000000000",
    },
  };
}

/** Fake read API: each method resolves fixed data unless overridden. */
export function fakeApi(overrides = {}) {
  const solvent = overrides.solvent ?? true;
  return {
    manager: { isSolvent: async () => solvent },
    token: { saleReserve: async () => KT(990_000), balanceOf: async () => KT(50) },
    provider: { getBalance: async () => KT(10) },
    getCampaignPage: async () => ({ campaigns: [campaign()], count: 1n, now: 2000n }),
    getCampaign: async (id, account) => ({ campaign: campaign({ id: BigInt(id) }), me: account ? { contribution: 0n, refunded: false, balance: KT(50), allowance: 0n } : null, now: 2000n }),
    getPlatform: async () => platform({ solvent }),
    getAccount: async (account) => ({
      account, eth: KT(10), kt: KT(50), allowance: 0n, now: 2000n, created: [], contributions: [], payouts: [], refunds: [],
      isManagerOwner: account === OWNER, isTokenOwner: account === OWNER, platformFeesOutstanding: KT(1), unwithdrawnProceeds: KT(100),
    }),
    ...overrides.api,
  };
}

export function fakeAppValue(overrides = {}) {
  const manifest = sampleManifest();
  return {
    deployment: { status: "verified", manifest, checks: [{ id: "chain", label: "Read RPC reports chain id 31337", ok: true }] },
    wallet: { status: "disconnected" },
    api: fakeApi(overrides),
    actions: {},
    txStore: createTxStore(),
    refreshKey: 0,
    refresh: () => {},
    connect: () => {},
    disconnect: () => {},
    writeBlockedReason: "Connect a wallet to make changes.",
    reverify: async () => true,
    ...overrides.value,
  };
}
