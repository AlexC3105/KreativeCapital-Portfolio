// Local-chain integration tests: run the frontend's real lib layer (manifest validation,
// on-chain verification, write-context revalidation, actions, evidence-based transaction runner)
// against a Hardhat node on 127.0.0.1:8546 deployed by the project's deploy script.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/integration/**/*.integration.test.js"],
    globalSetup: ["./test/integration/globalSetup.js"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    coverage: { provider: "v8", include: ["src/lib/**/*.js"], reporter: ["text", "json-summary"], reportsDirectory: "coverage-integration" },
  },
});
