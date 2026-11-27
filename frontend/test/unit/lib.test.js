// Unit tests for exact units, manifest validation, error classification and the evidence-based
// transaction runner. Test doubles are confined to this file.
import { describe, expect, it, vi } from "vitest";
import { Interface, keccak256 } from "ethers";
import {
  MAX_DURATION,
  TOTAL_SUPPLY,
  formatKT,
  ktForWei,
  parseAmount,
  parseDuration,
  settlementSplit,
  utf8Length,
} from "../../src/lib/units.js";
import { isLoopbackRpc, loadManifest, ManifestError, validateManifest } from "../../src/lib/manifest.js";
import { describeError, isUserRejection } from "../../src/lib/errors.js";
import { runTransaction, TxState } from "../../src/lib/tx.js";
import { matchesArtifact, verifyDeployment, verifyWalletChain } from "../../src/lib/verify.js";
import { sampleManifest } from "../helpers/fixtures.js";

describe("exact token units", () => {
  it("parses plain decimals into exact base units", () => {
    expect(parseAmount("1").value).toBe(10n ** 18n);
    expect(parseAmount("0.000000000000000001").value).toBe(1n);
    expect(parseAmount("12345.678901234567890123", { decimals: 21 }).value).toBe(12345678901234567890123000n); // 18 fractional digits scaled to 21 decimals
    expect(parseAmount("1000000").value).toBe(TOTAL_SUPPLY);
  });

  it("rejects signs, exponents, separators, excess precision, zero and garbage", () => {
    for (const bad of ["", " ", "-1", "+1", "1e3", "1,000", "1 000", "abc", "0x10", ".5", "01", "1."]) {
      expect(parseAmount(bad).error, bad).toBeTruthy();
    }
    expect(parseAmount("1.0000000000000000001").error).toMatch(/18 decimal places/);
    expect(parseAmount("0").error).toMatch(/greater than zero/);
    expect(parseAmount("0", { allowZero: true }).value).toBe(0n);
  });

  it("formats without losing precision and converts ETH to KT exactly", () => {
    expect(formatKT(1n)).toBe("0.000000000000000001 KT");
    expect(formatKT(10n ** 18n)).toBe("1 KT");
    expect(formatKT(1500000000000000000n)).toBe("1.5 KT");
    expect(ktForWei(1n)).toBe(100n);
    expect(ktForWei(5n * 10n ** 17n)).toBe(50n * 10n ** 18n);
  });

  it("mirrors the contract's floor fee split", () => {
    expect(settlementSplit(99n)).toEqual({ fee: 0n, creator: 99n });
    expect(settlementSplit(199n)).toEqual({ fee: 1n, creator: 198n });
    expect(settlementSplit(TOTAL_SUPPLY)).toEqual({ fee: TOTAL_SUPPLY / 100n, creator: TOTAL_SUPPLY - TOTAL_SUPPLY / 100n });
  });

  it("counts UTF-8 bytes, not characters", () => {
    expect(utf8Length("abc")).toBe(3);
    expect(utf8Length("é")).toBe(2);
    expect(utf8Length("😀")).toBe(4);
    expect(utf8Length("😀".repeat(16))).toBe(64);
  });

  it("validates total duration between 60 seconds and 365 days", () => {
    expect(parseDuration({ days: "0", hours: "0", minutes: "1" }).value).toBe(60n);
    expect(parseDuration({ days: "365", hours: "0", minutes: "0" }).value).toBe(MAX_DURATION);
    expect(parseDuration({ days: "0", hours: "0", minutes: "0" }).error).toMatch(/at least 60 seconds/);
    expect(parseDuration({ days: "365", hours: "0", minutes: "1" }).error).toMatch(/at most 365 days/);
    expect(parseDuration({ days: "1.5", hours: "0", minutes: "0" }).error).toMatch(/whole number/);
    expect(parseDuration({ days: "0", hours: "24", minutes: "0" }).value).toBe(86400n);
  });
});

describe("deployment manifest validation", () => {
  it("accepts a valid local schema-v2 manifest", () => {
    expect(validateManifest(sampleManifest())).toBeTruthy();
  });

  it.each([
    ["schemaVersion 1", (m) => (m.schemaVersion = 1)],
    ["chain 1", (m) => (m.chainId = 1)],
    ["non-loopback rpc", (m) => (m.rpcUrl = "http://192.168.1.20:8545")],
    ["public https rpc", (m) => (m.rpcUrl = "https://mainnet.example.org")],
    ["missing genesis", (m) => delete m.genesisHash],
    ["non-checksummed address", (m) => (m.contracts.KreativeToken.address = m.contracts.KreativeToken.address.toLowerCase())],
    ["missing contract", (m) => delete m.contracts.CampaignManager],
    ["bad block hash", (m) => (m.contracts.CampaignManager.blockHash = "0x1234")],
  ])("rejects %s", (_label, mutate) => {
    const m = sampleManifest();
    mutate(m);
    expect(() => validateManifest(m)).toThrow(ManifestError);
  });

  it("recognises loopback RPC URLs only", () => {
    expect(isLoopbackRpc("http://127.0.0.1:8545")).toBe(true);
    expect(isLoopbackRpc("http://localhost:8546")).toBe(true);
    expect(isLoopbackRpc("http://127.0.0.1.evil.example:8545")).toBe(false);
    expect(isLoopbackRpc("http://10.0.0.1:8545")).toBe(false);
  });

  it("rejects malformed manifest JSON and unreachable servers", async () => {
    const badJson = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => { throw new SyntaxError("bad"); } });
    await expect(loadManifest(badJson)).rejects.toMatchObject({ code: "invalid" });
    const wrongShape = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ schemaVersion: 2 }) });
    await expect(loadManifest(wrongShape)).rejects.toMatchObject({ code: "invalid" });
    await expect(loadManifest(vi.fn().mockRejectedValue(new TypeError("fetch failed")))).rejects.toMatchObject({ code: "unavailable" });
  });

  it("reports a missing manifest distinctly", async () => {
    const fetch404 = vi.fn().mockResolvedValue({ status: 404, ok: false });
    await expect(loadManifest(fetch404)).rejects.toMatchObject({ code: "missing" });
    expect(fetch404).toHaveBeenCalledWith("/kc-deployment.json", { cache: "no-store" });
  });
});

describe("deployment and wallet verification", () => {
  const TOKEN_CODE = "0x6080aa";
  // Manager runtime code embeds the token address as an immutable (32-byte padded).
  const tokenAddr = sampleManifest().contracts.KreativeToken.address;
  const padded = tokenAddr.slice(2).toLowerCase().padStart(64, "0");
  const MANAGER_CODE = `0x6080bb${padded}cc`;
  const MANAGER_ARTIFACT = `0x6080bb${"0".repeat(64)}cc`;

  function fakeProvider(m, overrides = {}) {
    return {
      send: vi.fn(async () => overrides.chainId ?? "0x7a69"),
      getBlock: vi.fn(async (n) => {
        if (n === 0) return { hash: overrides.genesis ?? m.genesisHash };
        const rec = Object.values(m.contracts).find((r) => r.blockNumber === n);
        return { hash: overrides.blockHash ?? rec.blockHash };
      }),
      getCode: vi.fn(async (a) => (a === m.contracts.KreativeToken.address ? TOKEN_CODE : MANAGER_CODE)),
    };
  }
  function consistentManifest() {
    const m = sampleManifest();
    m.contracts.KreativeToken.runtimeCodeHash = keccak256(TOKEN_CODE);
    m.contracts.CampaignManager.runtimeCodeHash = keccak256(MANAGER_CODE);
    return m;
  }
  const artifacts = { KreativeToken: { deployedBytecode: TOKEN_CODE, abi: [] }, CampaignManager: { deployedBytecode: MANAGER_ARTIFACT, abi: [] } };

  it("masks immutables when comparing deployed code with the artifact", () => {
    expect(matchesArtifact(MANAGER_CODE, MANAGER_ARTIFACT, [tokenAddr])).toBe(true);
    expect(matchesArtifact(MANAGER_CODE, MANAGER_ARTIFACT, [])).toBe(false);
  });

  it("flags a restarted chain (genesis/deployment block mismatch) as stale", async () => {
    const m = consistentManifest();
    const result = await verifyDeployment(fakeProvider(m, { genesis: "0x" + "ab".repeat(32), blockHash: "0x" + "cd".repeat(32) }), m, artifacts);
    expect(result.ok).toBe(false);
    expect(result.stale).toBe(true);
  });

  it("rejects a wrong chain id and mismatched code", async () => {
    const m = consistentManifest();
    const wrongChain = await verifyDeployment(fakeProvider(m, { chainId: "0x1" }), m, artifacts);
    expect(wrongChain.ok).toBe(false);
    expect(wrongChain.checks.find((c) => c.id === "chain").ok).toBe(false);
    m.contracts.CampaignManager.runtimeCodeHash = "0x" + "11".repeat(32);
    const badCode = await verifyDeployment(fakeProvider(m), m, artifacts);
    expect(badCode.checks.find((c) => c.id === "CampaignManager:code").ok).toBe(false);
  });

  it("rejects wallets on another network or on a different 31337 chain", async () => {
    const m = sampleManifest();
    const wallet = (chainId, hash) => ({
      request: async ({ method }) => (method === "eth_chainId" ? chainId : { hash: hash ?? m.genesisHash }),
    });
    expect((await verifyWalletChain(wallet("0x1"), m)).code).toBe("wrong-network");
    expect((await verifyWalletChain(wallet("0x7a69", "0x" + "99".repeat(32)), m)).code).toBe("different-chain");
    const ok = { request: async ({ method, params }) => (method === "eth_chainId" ? "0x7a69" : { hash: params[0] === "0x0" ? m.genesisHash : m.contracts.CampaignManager.blockHash }) };
    expect((await verifyWalletChain(ok, m)).ok).toBe(true);
  });
});

describe("error classification", () => {
  const iface = new Interface(["error Insolvent(uint256 balance, uint256 liabilities)", "error AlreadyClaimed()"]);
  it("identifies wallet rejections", () => {
    expect(isUserRejection({ code: "ACTION_REJECTED" })).toBe(true);
    expect(isUserRejection({ error: { code: 4001 } })).toBe(true);
    expect(describeError({ code: 4001 }).kind).toBe("rejected");
  });
  it("decodes custom errors and OpenZeppelin reasons", () => {
    const data = iface.encodeErrorResult("Insolvent", [1n, 2n]);
    expect(describeError({ data }, [iface])).toMatchObject({ kind: "revert", name: "Insolvent" });
    expect(describeError({ reason: "Ownable: caller is not the owner" }).message).toMatch(/on-chain owner/);
  });
  it("decodes ethers' Error(string) and Panic revert objects (regression from integration testing)", () => {
    expect(describeError({ revert: { name: "Error", args: ["ERC20: insufficient allowance"] } }).message).toMatch(/allowance is too low/);
    expect(describeError({ revert: { name: "Panic", args: [17n] } }).name).toBe("Panic(17)");
  });
});

describe("evidence-based transaction runner", () => {
  const contract = { interface: new Interface(["event Done(uint256 value)"]) };
  const ADDRESS = "0x00000000000000000000000000000000000000aa";
  const log = { address: ADDRESS, ...contract.interface.encodeEventLog("Done", [7n]) };
  const base = {
    label: "Test",
    prepare: async () => ({ ok: true, account: "0x00000000000000000000000000000000000000bb" }),
    simulate: async () => {},
    send: async () => ({ hash: "0x" + "12".repeat(32) }),
    waitForReceipt: async () => ({ status: 1, blockNumber: 5, logs: [log] }),
    expectEvent: () => ({ contract, address: ADDRESS, name: "Done", match: (a) => a.value === 7n }),
    verify: async () => true,
    describe: (e) => describeError(e),
  };
  async function states(overrides) {
    const seen = [];
    const final = await runTransaction({ ...base, ...overrides, onUpdate: (r) => seen.push(r.state) });
    return { seen, final };
  }

  it("reports CONFIRMED only after receipt, event and state verification", async () => {
    const { seen, final } = await states({});
    expect(seen).toEqual([TxState.VALIDATING, TxState.VALIDATING, TxState.AWAITING_WALLET, TxState.SUBMITTED, TxState.PENDING, TxState.VERIFYING, TxState.CONFIRMED]);
    expect(final.result.value).toBe(7n);
  });

  it("blocks when context revalidation fails (no wallet prompt)", async () => {
    const send = vi.fn();
    const { final } = await states({ prepare: async () => ({ ok: false, reason: "Stale deployment" }), send });
    expect(final).toMatchObject({ state: TxState.BLOCKED, message: "Stale deployment" });
    expect(send).not.toHaveBeenCalled();
  });

  it("blocks when the simulation reverts", async () => {
    const send = vi.fn();
    const { final } = await states({ simulate: async () => { throw { reason: "ERC20: insufficient allowance" }; }, send });
    expect(final.state).toBe(TxState.BLOCKED);
    expect(final.message).toMatch(/allowance/);
    expect(send).not.toHaveBeenCalled();
  });

  it("distinguishes wallet rejection", async () => {
    const { final } = await states({ send: async () => { throw { code: "ACTION_REJECTED" }; } });
    expect(final.state).toBe(TxState.REJECTED);
  });

  it("reports REVERTED for a mined failure and UNKNOWN for a missing receipt", async () => {
    expect((await states({ waitForReceipt: async () => ({ status: 0, blockNumber: 9, logs: [] }) })).final.state).toBe(TxState.REVERTED);
    expect((await states({ waitForReceipt: async () => { throw new Error("timeout"); } })).final.state).toBe(TxState.UNKNOWN);
    expect((await states({ waitForReceipt: async () => null })).final.state).toBe(TxState.UNKNOWN);
  });

  it("never reports success without the expected event or matching state", async () => {
    expect((await states({ expectEvent: () => ({ contract, address: ADDRESS, name: "Done", match: (a) => a.value === 8n }) })).final.state).toBe(TxState.UNKNOWN);
    expect((await states({ verify: async () => false })).final.state).toBe(TxState.UNKNOWN);
    expect((await states({ verify: async () => { throw new Error("rpc"); } })).final.state).toBe(TxState.UNKNOWN);
  });

  // TR-02: the read-only status check reuses the original evidence and the same checks.
  describe("status check of an UNKNOWN result (resolve)", () => {
    const late = { status: 1, blockNumber: 6, logs: [log] };
    const unknownWith = (overrides) => states({ waitForReceipt: async () => null, ...overrides });

    it("keeps a mismatch detected on time out of reconciliation (no resolve offered)", async () => {
      const { final } = await states({ checkMined: async () => "The mined transaction was sent by a different account than the one that started this action." });
      expect(final).toMatchObject({ state: TxState.UNKNOWN, evidence: "mismatch" });
      expect(final.resolve).toBeUndefined();
    });

    it("distinguishes not found, mismatch, reverted, unverified and confirmed late receipts", async () => {
      let receipt = null;
      let mismatch = null;
      let verified = true;
      const { final } = await unknownWith({
        getReceipt: async () => receipt,
        checkMined: async () => mismatch,
        verify: async () => verified,
      });
      expect(final).toMatchObject({ state: TxState.UNKNOWN, evidence: "not-found" });
      expect(typeof final.resolve).toBe("function");

      expect(await final.resolve()).toMatchObject({ state: TxState.UNKNOWN, evidence: "not-found" });

      receipt = late;
      mismatch = "The returned transaction was mined before this action was submitted.";
      expect(await final.resolve()).toMatchObject({ state: TxState.UNKNOWN, evidence: "mismatch" });

      mismatch = null;
      receipt = { status: 0, blockNumber: 6, logs: [] };
      expect(await final.resolve()).toMatchObject({ state: TxState.REVERTED, evidence: "reverted" });

      receipt = late;
      verified = false;
      expect(await final.resolve()).toMatchObject({ state: TxState.UNKNOWN, evidence: "unverified" });

      verified = true;
      const ok = await final.resolve();
      expect(ok).toMatchObject({ state: TxState.CONFIRMED, evidence: "verified" });
      expect(ok.result.value).toBe(7n);
    });

    it("refuses to evaluate a receipt once the chain instance changed", async () => {
      const getReceipt = vi.fn(async () => late);
      const { final } = await unknownWith({ getReceipt, checkChain: async () => false });
      expect(await final.resolve()).toMatchObject({ state: TxState.UNKNOWN, evidence: "chain-changed" });
      expect(getReceipt).not.toHaveBeenCalled();
    });
  });

  it("treats an uncertain submission as UNKNOWN, not failed", async () => {
    const { final } = await states({ send: async () => { throw new Error("socket hang up"); } });
    expect(final.state).toBe(TxState.UNKNOWN);
    expect(final.message).toMatch(/before trying again/);
  });
});
