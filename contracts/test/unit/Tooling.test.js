// Local-network enforcement for the deployment tooling and the development-only time helper.
// Non-loopback and deceptive destinations must be refused before any RPC contact.
const { expect } = require("chai");
const { execFileSync } = require("child_process");
const path = require("path");
const { isLoopbackRpcUrl, deployLocal } = require("../../scripts/lib/deployment");

describe("Local-network enforcement (tooling)", function () {
  it("accepts only strict loopback HTTP RPC URLs", function () {
    for (const ok of ["http://127.0.0.1:8545", "http://localhost:8545", "http://127.0.0.1:1", "http://localhost:65535"]) {
      expect(isLoopbackRpcUrl(ok), ok).to.equal(true);
    }
    const refused = [
      "https://127.0.0.1:8545", // not plain local HTTP
      "http://127.0.0.1", // no explicit port
      "http://127.0.0.1:8545/", // path
      "http://127.0.0.1:8545/rpc",
      "http://127.0.0.1:8545?x=1",
      "http://127.0.0.1:8545#x",
      "http://127.0.0.1:0",
      "http://127.0.0.1:65536",
      "http://127.0.0.1:08545", // leading zero
      "http://127.1:8545", // shorthand IPv4
      "http://2130706433:8545", // integer IPv4
      "http://0x7f000001:8545",
      "http://[::1]:8545",
      "http://localhost.:8545", // trailing dot
      "http://127.0.0.1.example.com:8545", // look-alike
      "http://localhost@example.com:8545", // credentials / host confusion
      "http://user:pass@127.0.0.1:8545",
      "http://example.com:8545",
      "http://10.0.0.5:8545",
      "http://0.0.0.0:8545",
      "HTTP://127.0.0.1:8545",
      " http://127.0.0.1:8545",
      "http://127.0.0.1:8545 ",
      "",
      undefined,
      null,
      8545,
    ];
    for (const bad of refused) expect(isLoopbackRpcUrl(bad), String(bad)).to.equal(false);
  });

  it("refuses to deploy to a non-loopback network before contacting it", async function () {
    for (const url of ["https://rpc.example.org", "http://10.0.0.5:8545", "http://127.0.0.1.example.com:8545", undefined]) {
      let contacted = false;
      const hre = {
        network: { name: url === undefined ? "custom" : "remote", config: url === undefined ? {} : { url } },
        config: {},
        ethers: { provider: { getNetwork: async () => { contacted = true; return { chainId: 31337n }; } } },
      };
      let error;
      try {
        await deployLocal(hre);
      } catch (e) {
        error = e;
      }
      expect(error, String(url)).to.be.instanceOf(Error);
      expect(error.message).to.match(/Refusing to deploy/);
      expect(contacted, `${url} must not be contacted`).to.equal(false);
    }
  });

  it("the development-only time helper refuses invalid input and non-loopback URLs", function () {
    const script = path.join(__dirname, "..", "..", "scripts", "dev", "advance-time.mjs");
    const run = (...args) => {
      try {
        execFileSync(process.execPath, [script, ...args], { stdio: "pipe", timeout: 10000 });
        return { status: 0, stderr: "" };
      } catch (e) {
        return { status: e.status, stderr: String(e.stderr) };
      }
    };
    for (const args of [[], ["0"], ["-5"], ["1.5"], ["31622401"], ["abc"]]) {
      const r = run(...args);
      expect(r.status, args.join(" ")).to.equal(1);
      expect(r.stderr).to.match(/Usage/);
    }
    for (const url of ["http://example.com:8545", "https://127.0.0.1:8545", "http://127.0.0.1.example.com:8545", "http://localhost@example.com:8545", "http://[::1]:8545"]) {
      const r = run("60", url);
      expect(r.status, url).to.equal(1);
      expect(r.stderr).to.match(/not a loopback RPC URL/);
    }
  });

  it("the documented node command binds to 127.0.0.1", function () {
    const pkg = require("../../package.json");
    expect(pkg.scripts.node).to.equal("hardhat node --hostname 127.0.0.1");
  });
});
