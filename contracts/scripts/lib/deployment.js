/**
 * Local deployment helpers for the canonical contracts.
 *
 * Deploys KreativeToken, then CampaignManager(token), to the local development chain only.
 * Manifest schema v2 (architecture §8.1):
 *   - deterministic fields: chainId, addresses, deployment transactions, block numbers,
 *     runtime code hashes, compiler settings, dev account addresses;
 *   - chain-instance identifiers: genesisHash and per-contract blockHash. These change when
 *     the node restarts and are used by the frontend to detect stale manifests.
 * No timestamps, no private keys.
 */
const fs = require("fs");
const path = require("path");
const { isLoopbackRpcUrl } = require("./loopback");

const LOCAL_CHAIN_ID = 31337n;
const MANIFEST_SCHEMA_VERSION = 2;
const DEFAULT_RPC_URL = "http://127.0.0.1:8545";
const ACCOUNT_COUNT = 10;
const CANONICAL_CONTRACTS = ["KreativeToken", "CampaignManager"];

async function deployedRecord(hre, contract) {
  const { ethers } = hre;
  const tx = contract.deploymentTransaction();
  const receipt = await tx.wait();
  const address = await contract.getAddress();
  const code = await ethers.provider.getCode(address);
  return {
    address,
    deploymentTransaction: tx.hash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    runtimeCodeHash: ethers.keccak256(code),
  };
}

/**
 * Deploy to the current Hardhat network and return the manifest object.
 * Refuses to run against anything other than the local development chain.
 */
async function deployLocal(hre) {
  const { ethers, network, config } = hre;
  // Destination check before any RPC contact: only the in-process Hardhat network or an HTTP
  // network whose configured URL is a strict loopback URL.
  const url = network.config && network.config.url;
  const inProcess = network.name === "hardhat" && url === undefined;
  if (!inProcess && !isLoopbackRpcUrl(url)) {
    throw new Error(
      `Refusing to deploy: network "${network.name}" is not the in-process Hardhat network or a loopback RPC URL (http://127.0.0.1:<port> or http://localhost:<port>).`
    );
  }
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== LOCAL_CHAIN_ID) {
    throw new Error(
      `Refusing to deploy: chainId ${chainId} is not the local development chain (${LOCAL_CHAIN_ID}).`
    );
  }

  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const genesis = await ethers.provider.getBlock(0);

  const token = await ethers.deployContract("KreativeToken");
  const tokenRecord = await deployedRecord(hre, token);
  const manager = await ethers.deployContract("CampaignManager", [tokenRecord.address]);
  const managerRecord = await deployedRecord(hre, manager);

  const solidity = config.solidity.compilers[0];
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    network: network.name,
    chainId: Number(chainId),
    // HTTP networks record their configured (loopback) URL; the in-process network records the
    // default local node URL.
    rpcUrl: typeof network.config.url === "string" ? network.config.url : DEFAULT_RPC_URL,
    genesisHash: genesis.hash,
    deployer: deployer.address,
    // Public Hardhat development account addresses (never private keys).
    accounts: signers.slice(0, ACCOUNT_COUNT).map((s) => s.address),
    compiler: {
      version: solidity.version,
      optimizer: solidity.settings.optimizer,
      evmVersion: solidity.settings.evmVersion,
    },
    contracts: {
      KreativeToken: tokenRecord,
      CampaignManager: managerRecord,
    },
  };
}

/** Manifest fields that must be identical across fresh chains (excludes chain-instance ids). */
function deterministicView(manifest) {
  const { genesisHash, contracts, ...rest } = manifest;
  return {
    ...rest,
    contracts: Object.fromEntries(
      Object.entries(contracts).map(([name, { blockHash, ...record }]) => [name, record])
    ),
  };
}

function writeManifest(manifest, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${manifest.network}.json`);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  return file;
}

module.exports = {
  isLoopbackRpcUrl,
  deployLocal,
  writeManifest,
  deterministicView,
  LOCAL_CHAIN_ID,
  MANIFEST_SCHEMA_VERSION,
  CANONICAL_CONTRACTS,
};
