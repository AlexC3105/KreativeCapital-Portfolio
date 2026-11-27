/**
 * Copy the canonical compiled artifacts into frontend/src/abi/ (generated, git-ignored).
 *
 * Exports only the canonical contracts (KreativeToken, CampaignManager). Test-only mocks are
 * never exported. Previously exported files that are no longer canonical (e.g. the retired
 * 2024 CrowdfundingFactory/CrowdfundingCampaign artifacts) are removed from this generated
 * folder so the frontend cannot silently keep using stale artifacts. Run `npm run compile`.
 */
const fs = require("fs");
const path = require("path");
const { CANONICAL_CONTRACTS } = require("./lib/deployment");

const artifactsDir = path.join(__dirname, "..", "artifacts", "contracts");
const outDir = path.join(__dirname, "..", "..", "frontend", "src", "abi");

fs.mkdirSync(outDir, { recursive: true });
for (const name of CANONICAL_CONTRACTS) {
  const src = path.join(artifactsDir, `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(src)) {
    console.error(`Missing artifact ${path.relative(process.cwd(), src)}. Run "hardhat compile" first.`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(outDir, `${name}.json`));
}
const wanted = new Set(CANONICAL_CONTRACTS.map((n) => `${n}.json`));
const removed = fs.readdirSync(outDir).filter((f) => f.endsWith(".json") && !wanted.has(f));
for (const f of removed) fs.unlinkSync(path.join(outDir, f));
console.log(
  `Exported ${CANONICAL_CONTRACTS.length} canonical artifacts to ${path.relative(process.cwd(), outDir)}` +
    (removed.length ? `; removed stale: ${removed.join(", ")}` : "")
);
