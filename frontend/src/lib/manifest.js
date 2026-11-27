// Deployment manifest (schema v2) loading and structural validation. The manifest is generated
// at runtime by `npm run deploy:local` and served by the local Vite server; it is never
// tracked. Validation here is structural; on-chain verification lives in verify.js.
import { getAddress } from "ethers";

export const EXPECTED_CHAIN_ID = 31337;
export const DEPLOYMENT_PATH = "/kc-deployment.json";
export const CONTRACT_NAMES = ["KreativeToken", "CampaignManager"];
const LOOPBACK_RPC = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d{2,5})$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

export class ManifestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function isLoopbackRpc(url) {
  const m = LOOPBACK_RPC.exec(String(url));
  return Boolean(m) && Number(m[1]) > 0 && Number(m[1]) < 65536;
}

/** Throws ManifestError if the manifest is not a valid local schema-v2 manifest. */
export function validateManifest(m) {
  const bad = (msg) => {
    throw new ManifestError("invalid", `Deployment manifest rejected: ${msg}`);
  };
  if (!m || typeof m !== "object") bad("not an object");
  if (m.schemaVersion !== 2) bad(`unsupported schemaVersion ${m.schemaVersion} (expected 2)`);
  if (m.chainId !== EXPECTED_CHAIN_ID) bad(`chainId ${m.chainId} is not the local development chain ${EXPECTED_CHAIN_ID}`);
  if (!isLoopbackRpc(m.rpcUrl)) bad("rpcUrl must be a loopback HTTP URL (127.0.0.1 or localhost)");
  if (!HASH.test(m.genesisHash || "")) bad("missing genesisHash");
  if (!m.contracts || typeof m.contracts !== "object") bad("missing contracts");
  for (const name of CONTRACT_NAMES) {
    const r = m.contracts[name];
    if (!r) bad(`missing ${name}`);
    let checksummed;
    try {
      checksummed = getAddress(r.address);
    } catch {
      bad(`${name} address is invalid`);
    }
    if (checksummed !== r.address) bad(`${name} address is not checksummed`);
    if (!Number.isInteger(r.blockNumber) || r.blockNumber < 1) bad(`${name} blockNumber is invalid`);
    for (const f of ["blockHash", "runtimeCodeHash", "deploymentTransaction"]) {
      if (!HASH.test(r[f] || "")) bad(`${name} ${f} is invalid`);
    }
  }
  return m;
}

/** Fetch the runtime-served manifest from the local app server. */
export async function loadManifest(fetchImpl = globalThis.fetch) {
  let res;
  try {
    res = await fetchImpl(DEPLOYMENT_PATH, { cache: "no-store" });
  } catch {
    throw new ManifestError("unavailable", "The local app server did not return a deployment manifest.");
  }
  if (res.status === 404) {
    throw new ManifestError(
      "missing",
      'No local deployment found. Start the local chain ("npm run node") and deploy ("npm run deploy:local").'
    );
  }
  if (!res.ok) throw new ManifestError("unavailable", `Deployment manifest request failed (${res.status}).`);
  let json;
  try {
    json = await res.json();
  } catch {
    throw new ManifestError("invalid", "Deployment manifest is not valid JSON.");
  }
  return validateManifest(json);
}
