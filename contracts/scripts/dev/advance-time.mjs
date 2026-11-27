#!/usr/bin/env node
// DEVELOPMENT-ONLY demo helper: advance the LOCAL Hardhat chain's clock and mine a block so
// campaign deadlines can be reached during a demonstration. It is not part of the application
// and only talks to a strict loopback RPC URL (see scripts/lib/loopback.js) that reports chain
// id 31337. Hardhat-only methods (evm_increaseTime, evm_mine) do not exist on real networks.
//   npm run dev:advance-time -- <seconds> [rpcUrl]      (default rpcUrl http://127.0.0.1:8545)
import { createRequire } from "node:module";
const { isLoopbackRpcUrl } = createRequire(import.meta.url)("../lib/loopback.js");
const seconds = Number(process.argv[2]);
const rpcUrl = process.argv[3] ?? "http://127.0.0.1:8545";
if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 366 * 24 * 3600) {
  console.error("Usage: npm run dev:advance-time -- <seconds> [rpcUrl]   (1 .. 31622400 seconds)");
  process.exit(1);
}
if (!isLoopbackRpcUrl(rpcUrl)) {
  console.error(`Refusing: ${rpcUrl} is not a loopback RPC URL.`);
  process.exit(1);
}
async function call(method, params = []) {
  const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}
const chainId = BigInt(await call("eth_chainId"));
if (chainId !== 31337n) {
  console.error(`Refusing: chain id ${chainId} is not the local development chain 31337.`);
  process.exit(1);
}
const before = BigInt((await call("eth_getBlockByNumber", ["latest", false])).timestamp);
await call("evm_increaseTime", [seconds]);
await call("evm_mine");
const after = BigInt((await call("eth_getBlockByNumber", ["latest", false])).timestamp);
console.log(`Local chain time advanced by ${after - before} s (block timestamp ${before} -> ${after}).`);
