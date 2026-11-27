/**
 * Vite configuration.
 *
 * - React 18 + ethers v6 frontend for the canonical KreativeToken / CampaignManager contracts.
 * - The deployment manifest is NOT bundled or tracked: `npm run deploy:local` writes
 *   contracts/deployments/<network>.json at runtime, and the local dev/preview server exposes it
 *   at /kc-deployment.json (no-store). The app validates and verifies it on-chain.
 * - Servers bind to loopback only. No external fonts, CDNs, analytics or telemetry.
 * - KC_DEPLOYMENT_NETWORK (non-secret) selects the manifest name; default "localhost".
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));
const NETWORK = /^[A-Za-z0-9_-]+$/.test(process.env.KC_DEPLOYMENT_NETWORK ?? "") ? process.env.KC_DEPLOYMENT_NETWORK : "localhost";
const MANIFEST_FILE = path.resolve(here, "..", "contracts", "deployments", `${NETWORK}.json`);
const ROUTE = "/kc-deployment.json";

function deploymentManifest() {
  const handler = (req, res, next) => {
    if (req.url?.split("?")[0] !== ROUTE) return next();
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    if (!fs.existsSync(MANIFEST_FILE)) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "No local deployment manifest. Run npm run deploy:local." }));
      return;
    }
    res.end(fs.readFileSync(MANIFEST_FILE));
  };
  return {
    name: "kc-deployment-manifest",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), deploymentManifest()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 900 },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{js,jsx}"],
    exclude: ["test/integration/**", "node_modules/**"],
    setupFiles: ["./test/setup.js"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{js,jsx}"],
      exclude: ["src/abi/**", "src/main.jsx"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
    },
  },
});
