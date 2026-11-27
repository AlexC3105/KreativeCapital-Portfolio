// Environment smoke tests: pinned compiler, local chain, artifacts, deployment and manifest
// generation. They are NOT contract correctness tests; those live in test/unit and test/invariants.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { expect } = require("chai");
const hre = require("hardhat");
const {
  deployLocal,
  writeManifest,
  deterministicView,
  MANIFEST_SCHEMA_VERSION,
  CANONICAL_CONTRACTS,
} = require("../../scripts/lib/deployment");

const { ethers, network, config } = hre;
const CONTRACTS = CANONICAL_CONTRACTS; // KreativeToken, CampaignManager
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;

async function freshChain() {
  await network.provider.send("hardhat_reset");
}

describe("Environment smoke checks", function () {
  it("pins solc 0.8.24 with the optimizer disabled and EVM target paris", function () {
    expect(config.solidity.compilers).to.have.lengthOf(1);
    const [compiler] = config.solidity.compilers;
    expect(compiler.version).to.equal("0.8.24");
    expect(compiler.settings.optimizer).to.deep.include({ enabled: false, runs: 200 });
    expect(compiler.settings.evmVersion).to.equal("paris");
  });

  it("runs on the local Hardhat Network (31337) with funded disposable accounts", async function () {
    expect(network.name).to.equal("hardhat");
    const { chainId } = await ethers.provider.getNetwork();
    expect(chainId).to.equal(31337n);
    const signers = await ethers.getSigners();
    expect(signers.length).to.be.at.least(10);
    const balance = await ethers.provider.getBalance(signers[0].address);
    expect(balance > 0n, `deployer balance ${balance}`).to.equal(true);
  });

  it("produces artifacts for every contract, exported byte-for-byte to the frontend", function () {
    for (const name of CONTRACTS) {
      const artifactPath = path.join(config.paths.artifacts, "contracts", `${name}.sol`, `${name}.json`);
      const exportedPath = path.join(__dirname, "..", "..", "..", "frontend", "src", "abi", `${name}.json`);
      expect(fs.existsSync(artifactPath), `${name} artifact`).to.equal(true);
      expect(fs.existsSync(exportedPath), `${name} frontend copy (run "npm run compile")`).to.equal(true);
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
      expect(artifact.abi).to.be.an("array").that.is.not.empty;
      expect(artifact.bytecode).to.match(/^0x[0-9a-f]+$/);
      expect(fs.readFileSync(exportedPath, "utf8")).to.equal(fs.readFileSync(artifactPath, "utf8"));
    }
  });

  it("deploys both canonical contracts, wires the manager to the token, and writes a valid manifest", async function () {
    await freshChain();
    const manifest = await deployLocal(hre);

    expect(manifest.schemaVersion).to.equal(MANIFEST_SCHEMA_VERSION);
    expect(manifest.chainId).to.equal(31337);
    expect(manifest.accounts).to.have.lengthOf(10);
    manifest.accounts.forEach((a) => expect(a).to.match(ADDRESS));
    expect(manifest.schemaVersion).to.equal(2);
    expect(manifest.genesisHash).to.equal((await ethers.provider.getBlock(0)).hash);
    expect(manifest.compiler).to.deep.equal({
      version: "0.8.24",
      optimizer: { enabled: false, runs: 200 },
      evmVersion: "paris",
    });

    expect(Object.keys(manifest.contracts).sort()).to.deep.equal([...CONTRACTS].sort());
    for (const name of CONTRACTS) {
      const record = manifest.contracts[name];
      expect(record.address).to.match(ADDRESS);
      expect(record.deploymentTransaction).to.match(HASH);
      expect(record.blockNumber).to.be.a("number").greaterThan(0);
      const code = await ethers.provider.getCode(record.address);
      expect(code).to.not.equal("0x");
      expect(record.runtimeCodeHash).to.equal(ethers.keccak256(code));
      expect(record.blockHash).to.equal((await ethers.provider.getBlock(record.blockNumber)).hash);
    }

    const token = await ethers.getContractAt("KreativeToken", manifest.contracts.KreativeToken.address);
    const manager = await ethers.getContractAt("CampaignManager", manifest.contracts.CampaignManager.address);
    expect(await token.symbol()).to.equal("KT");
    expect(await manager.token()).to.equal(manifest.contracts.KreativeToken.address);
    expect(await manager.owner()).to.equal(manifest.deployer);
    expect(await token.owner()).to.equal(manifest.deployer);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-deploy-"));
    const file = writeManifest(manifest, dir);
    expect(path.basename(file)).to.equal("hardhat.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).to.deep.equal(manifest);
    expect(fs.readFileSync(file, "utf8")).to.not.match(/private|mnemonic/i);
  });

  it("produces an identical manifest (all deterministic fields) when deploying to a fresh chain again", async function () {
    await freshChain();
    const first = await deployLocal(hre);
    await freshChain();
    const second = await deployLocal(hre);
    // genesisHash / blockHash identify the chain instance (stale-manifest detection) and are
    // excluded by design; every other field must match exactly.
    expect(deterministicView(second)).to.deep.equal(deterministicView(first));
    expect(Object.keys(deterministicView(first).contracts.CampaignManager)).to.include("runtimeCodeHash");
  });

  it("refuses to deploy to any chain other than the local development chain", async function () {
    const publicChain = {
      ...hre,
      ethers: { ...ethers, provider: { getNetwork: async () => ({ chainId: 1n }) } },
    };
    let error;
    try {
      await deployLocal(publicChain);
    } catch (e) {
      error = e;
    }
    expect(error, "deployLocal should reject chainId 1").to.be.instanceOf(Error);
    expect(error.message).to.match(/Refusing to deploy: chainId 1/);
  });

  it("compiles only the canonical contracts (plus test-only mocks)", function () {
    const sources = fs.readdirSync(config.paths.sources).filter((f) => f.endsWith(".sol")).sort();
    expect(sources).to.deep.equal(["CampaignManager.sol", "KreativeToken.sol"]);
    const mocks = fs.readdirSync(path.join(config.paths.sources, "test-mocks")).every((f) => f.startsWith("Mock"));
    expect(mocks, "test-mocks contains only Mock* contracts").to.equal(true);
    for (const retired of ["CrowdfundingFactory.sol", "CrowdfundingCampaign.sol"]) {
      expect(fs.existsSync(path.join(config.paths.sources, retired)), retired).to.equal(false);
    }
  });
});
