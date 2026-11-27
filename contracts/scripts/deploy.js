/**
 * Deploy the canonical contracts (KreativeToken, CampaignManager) to the LOCAL development
 * chain and write a schema-v2 manifest to contracts/deployments/<network>.json.
 *
 * Usage (from the repository root):
 *   npm run node           # terminal 1: local Hardhat node on 127.0.0.1:8545
 *   npm run deploy:local   # terminal 2
 *
 * Local development only. Refuses any chain other than 31337. Educational, unaudited code.
 */
const path = require("path");
const hre = require("hardhat");
const { deployLocal, writeManifest } = require("./lib/deployment");

async function main() {
  const manifest = await deployLocal(hre);
  const file = writeManifest(manifest, path.join(__dirname, "..", "deployments"));
  console.log(`Network:         ${manifest.network} (chainId ${manifest.chainId})`);
  console.log(`KreativeToken:   ${manifest.contracts.KreativeToken.address}`);
  console.log(`CampaignManager: ${manifest.contracts.CampaignManager.address}`);
  console.log(`Manifest:        ${path.relative(process.cwd(), file)} (schema v${manifest.schemaVersion})`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
