// On-chain verification of the local deployment and of the wallet's chain. A matching chain id
// alone is never treated as proof (architecture §8.1).
import { Contract, keccak256, toQuantity, zeroPadValue } from "ethers";
import { EXPECTED_CHAIN_ID } from "./manifest.js";

/**
 * Compare on-chain runtime code with the compiled artifact's deployedBytecode. Immutable values
 * (e.g. CampaignManager.token) are embedded in deployed code but zero in the artifact, so their
 * padded occurrences are masked before comparison.
 */
export function matchesArtifact(onchainCode, artifactDeployedBytecode, immutableAddresses = []) {
  let code = String(onchainCode).toLowerCase();
  for (const value of immutableAddresses) {
    const padded = zeroPadValue(value, 32).slice(2).toLowerCase();
    code = code.split(padded).join("0".repeat(64));
  }
  return code === String(artifactDeployedBytecode).toLowerCase();
}

/**
 * Verify the manifest against the read RPC: chain id, chain instance (genesis), deployment
 * blocks, runtime code hashes, artifact bytecode and contract wiring.
 * @returns {{ ok: boolean, stale: boolean, checks: {id,label,ok,detail?}[] }}
 */
export async function verifyDeployment(provider, manifest, artifacts) {
  const checks = [];
  const add = (id, label, ok, detail) => checks.push({ id, label, ok: Boolean(ok), detail });

  const chainId = BigInt(await provider.send("eth_chainId", []));
  add("chain", "Read RPC reports chain id 31337", chainId === BigInt(EXPECTED_CHAIN_ID), `chain id ${chainId}`);
  const genesis = await provider.getBlock(0);
  add("genesis", "Chain instance (genesis block) matches the manifest", genesis && genesis.hash === manifest.genesisHash);

  const token = manifest.contracts.KreativeToken;
  for (const name of ["KreativeToken", "CampaignManager"]) {
    const rec = manifest.contracts[name];
    const block = await provider.getBlock(rec.blockNumber);
    add(`${name}:block`, `${name} deployment block matches`, block && block.hash === rec.blockHash);
    const code = await provider.getCode(rec.address);
    add(`${name}:code`, `${name} runtime code hash matches the manifest`, code !== "0x" && keccak256(code) === rec.runtimeCodeHash);
    const immutables = name === "CampaignManager" ? [token.address] : [];
    add(
      `${name}:artifact`,
      `${name} deployed bytecode matches the compiled artifact`,
      code !== "0x" && matchesArtifact(code, artifacts[name].deployedBytecode, immutables)
    );
  }

  if (checks.every((c) => c.ok)) {
    const tokenC = new Contract(token.address, artifacts.KreativeToken.abi, provider);
    const managerC = new Contract(manifest.contracts.CampaignManager.address, artifacts.CampaignManager.abi, provider);
    add("wiring", "CampaignManager.token() is the manifest's KreativeToken", (await managerC.token()) === token.address);
    add("symbol", "Token symbol is KT", (await tokenC.symbol()) === "KT");
  }
  const instanceIds = ["genesis", "KreativeToken:block", "CampaignManager:block", "KreativeToken:code", "CampaignManager:code"];
  return {
    ok: checks.every((c) => c.ok),
    stale: checks.some((c) => instanceIds.includes(c.id) && !c.ok),
    checks,
  };
}

/**
 * Verify that the wallet's provider is connected to the same local chain instance.
 * @returns {{ ok: true } | { ok: false, reason: string, code: string }}
 */
export async function verifyWalletChain(eip1193, manifest) {
  const chainId = BigInt(await eip1193.request({ method: "eth_chainId" }));
  if (chainId !== BigInt(EXPECTED_CHAIN_ID)) {
    return {
      ok: false,
      code: "wrong-network",
      reason: `Your wallet is on chain ${chainId}. Switch it to the local development chain (31337).`,
    };
  }
  const genesis = await eip1193.request({ method: "eth_getBlockByNumber", params: ["0x0", false] });
  const rec = manifest.contracts.CampaignManager;
  const block = await eip1193.request({ method: "eth_getBlockByNumber", params: [toQuantity(rec.blockNumber), false] });
  if (!genesis || genesis.hash !== manifest.genesisHash || !block || block.hash !== rec.blockHash) {
    return {
      ok: false,
      code: "different-chain",
      reason: "Your wallet is connected to a different chain that also uses id 31337. Point it at this app's local node.",
    };
  }
  return { ok: true };
}
