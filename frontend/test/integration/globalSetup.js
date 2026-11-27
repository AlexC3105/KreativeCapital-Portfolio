// Starts a disposable Hardhat node on 127.0.0.1:8546 (development accounts come from Hardhat
// itself; no keys are configured), deploys the canonical contracts with the project deploy
// script and exposes the generated manifest path to the tests. Stops the node afterwards.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const contractsDir = path.resolve(here, "..", "..", "..", "contracts");
const hardhat = path.resolve(contractsDir, "..", "node_modules", ".bin", "hardhat");
const RPC = "http://127.0.0.1:8546";
const env = { ...process.env, HARDHAT_DISABLE_TELEMETRY_PROMPT: "true" };

async function rpcReady() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Hardhat integration node did not start on " + RPC);
}

export default async function setup({ provide }) {
  try {
    await fetch(RPC, { method: "POST" });
    throw new Error(`Port 8546 is already in use; stop the process using it before running integration tests.`);
  } catch (e) {
    if (String(e.message).includes("already in use")) throw e;
  }
  const node = spawn(hardhat, ["node", "--hostname", "127.0.0.1", "--port", "8546"], { cwd: contractsDir, env, stdio: "ignore" });
  await rpcReady();
  const deploy = spawnSync(hardhat, ["run", "scripts/deploy.js", "--network", "kcIntegration"], { cwd: contractsDir, env, encoding: "utf8" });
  if (deploy.status !== 0) {
    node.kill();
    throw new Error("Integration deployment failed:\n" + deploy.stdout + deploy.stderr);
  }
  provide("manifestPath", path.join(contractsDir, "deployments", "kcIntegration.json"));
  provide("rpcUrl", RPC);
  return () => {
    node.kill();
  };
}
