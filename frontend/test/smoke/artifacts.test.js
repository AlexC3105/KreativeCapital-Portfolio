// Environment smoke test: the generated contract artifacts the frontend imports are the
// canonical ones (KreativeToken, CampaignManager), with the full artifact shape (abi + bytecode).
// This proves artifact export works; it does NOT test any frontend workflow.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import KreativeToken from "../../src/abi/KreativeToken.json";
import CampaignManager from "../../src/abi/CampaignManager.json";

const abiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/abi");

describe("generated canonical contract artifacts", () => {
  it("are importable with the artifact shape the frontend uses (abi + bytecode)", () => {
    for (const [artifact, name] of [
      [KreativeToken, "KreativeToken"],
      [CampaignManager, "CampaignManager"],
    ]) {
      expect(artifact.contractName).toBe(name);
      expect(artifact.sourceName).toBe(`contracts/${name}.sol`);
      expect(Array.isArray(artifact.abi) && artifact.abi.length).toBeGreaterThan(0);
      expect(artifact.bytecode).toMatch(/^0x[0-9a-f]{100,}$/);
    }
    const fns = CampaignManager.abi.filter((e) => e.type === "function").map((e) => e.name);
    for (const f of ["createCampaign", "contribute", "finalize", "claimCreatorPayout", "claimRefund", "isSolvent"]) {
      expect(fns).toContain(f);
    }
  });

  it("contain only the canonical artifacts (retired 2024 artifacts are not exported)", () => {
    expect(fs.readdirSync(abiDir).filter((f) => f.endsWith(".json")).sort()).toEqual([
      "CampaignManager.json",
      "KreativeToken.json",
    ]);
  });
});
