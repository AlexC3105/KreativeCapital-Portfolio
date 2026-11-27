require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("solidity-coverage");

/**
 * Hardhat configuration.
 *
 * Compiler settings are pinned explicitly so that the build is reproducible and
 * matches the original 2024 capstone build: solc 0.8.24, optimizer disabled
 * (runs: 200 as recorded in the 2024 build-info), EVM target "paris".
 *
 * Only the in-process Hardhat Network and a local Hardhat node (localhost) are
 * configured. No public networks, RPC keys or private keys are used: the local
 * node provides disposable, publicly known development accounts.
 *
 * Test-only mock contracts live in ./contracts/test-mocks (Hardhat compiles a single sources
 * tree). They are never deployed by scripts and never exported to the frontend.
 *
 * Tests: only ./test is executed.
 */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: false, runs: 200 },
      evmVersion: "paris",
    },
  },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    // Separate loopback node used only by the frontend local-chain integration tests.
    kcIntegration: { url: "http://127.0.0.1:8546", chainId: 31337 },
    // Separate loopback node used only by the browser validation harness (frontend/e2e).
    kcBrowser: { url: "http://127.0.0.1:8547", chainId: 31337 },
    // Separate loopback node for the owner's manual wallet-extension validation (docs/manual-wallet-validation.md).
    kcManual: { url: "http://127.0.0.1:8555", chainId: 31337 },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    artifacts: "./artifacts",
    cache: "./cache",
  },
};
