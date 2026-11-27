#!/usr/bin/env node
// Browser validation. TEST-ONLY harness; not part of the application.
//
// - Starts a disposable Hardhat node on 127.0.0.1:8547, deploys the canonical contracts, builds
//   the frontend and serves it with `vite preview` on 127.0.0.1:4174 (loopback only). These
//   dedicated ports never collide with a developer session (`npm run node` 8545, `npm run dev` 5173).
// - Launches headless Chrome with an isolated temporary profile and three outbound layers:
//   (1) all non-loopback traffic is routed to a dead local proxy (127.0.0.1:9),
//   (2) host-resolver rules return NOTFOUND for every non-local host,
//   (3) DevTools Fetch interception fails and records every non-loopback page request.
// - Injects a test-only EIP-1193 wallet (EIP-6963 announced) that forwards to the local node,
//   whose development accounts are unlocked; no private keys or seed phrases are used.
// - Drives the real UI through the successful and failed campaign lifecycles with WebGL
//   disabled, then checks wallet selection, browser-level insolvency (test-only storage write via
//   Hardhat RPC), wrong-network and stale-chain handling, the WebGL hero path, reduced motion and a
//   mobile viewport, and runs axe-core accessibility checks on every primary route and state.
//
// Usage: npm run e2e:browser   (CHROME_PATH may point to a Chrome/Chromium binary;
//        KC_E2E_OUT selects the output directory for the JSON report and screenshots.)
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const contractsDir = path.join(root, "contracts");
const frontendDir = path.join(root, "frontend");
const bin = (name) => path.join(root, "node_modules", ".bin", name);
const RPC = "http://127.0.0.1:8547";
const APP = "http://127.0.0.1:4174";
const NETWORK = "kcBrowser";
const OUT = process.env.KC_E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), "kc-e2e-"));
fs.mkdirSync(OUT, { recursive: true });
const env = { ...process.env, HARDHAT_DISABLE_TELEMETRY_PROMPT: "true" };
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const results = [];
const blocked = [];
const axeResults = [];
const punctuationResults = []; // presentation rule: no em dashes or semicolons in rendered app text
const AXE_SOURCE = fs.readFileSync(path.join(root, "node_modules", "axe-core", "axe.min.js"), "utf8");
const children = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[e2e]", ...a);

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  log(ok ? "PASS" : "FAIL", name, detail);
}

async function rpc(method, params = []) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function waitFor(fn, { timeout = 30000, interval = 200, label = "condition" } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch {
      /* retry */
    }
    await wait(interval);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function portFree(url) {
  try {
    await fetch(url, { method: "POST" });
    return false;
  } catch {
    return true;
  }
}

function startNode() {
  const node = spawn(bin("hardhat"), ["node", "--hostname", "127.0.0.1", "--port", "8547"], { cwd: contractsDir, env, stdio: "ignore" });
  children.push(node);
  return node;
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

// ---------------------------------------------------------------- Chrome DevTools Protocol
class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method && this.handlers.has(msg.method)) {
        this.handlers.get(msg.method)(msg.params);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, fn) {
    this.handlers.set(method, fn);
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  exists(sel) {
    return this.eval(`!!document.querySelector(${JSON.stringify(sel)})`);
  }
  text(sel) {
    return this.eval(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
  }
  async click(sel) {
    await waitFor(() => this.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.disabled; })()`), { label: `enabled ${sel}` });
    await this.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
  }
  async type(sel, value) {
    await waitFor(() => this.exists(sel), { label: sel });
    await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  }
  /** SPA navigation (keeps the connected wallet session). */
  async go(route) {
    await this.eval(`history.pushState({}, "", ${JSON.stringify(route)}); dispatchEvent(new PopStateEvent("popstate"));`);
    await wait(150);
  }
  /** Wait for a terminal transaction state for a status box whose label contains `label`. */
  async tx(label, timeout = 60000) {
    return waitFor(
      () =>
        this.eval(`(() => {
          const boxes = [...document.querySelectorAll('[data-testid="tx-status"]')].filter((b) => b.textContent.includes(${JSON.stringify(label)}));
          const b = boxes[boxes.length - 1];
          if (!b) return null;
          const s = b.dataset.state;
          return ["confirmed", "blocked", "rejected", "reverted", "unknown"].includes(s) ? { state: s, text: b.textContent } : null;
        })()`),
      { timeout, label: `tx ${label}` }
    );
  }
  async screenshot(name) {
    // Full-page capture (bounded height) so transaction status below the fold is included.
    const { cssContentSize, cssLayoutViewport } = await this.send("Page.getLayoutMetrics");
    const width = cssLayoutViewport.clientWidth;
    const height = Math.min(Math.ceil(cssContentSize.height), 2400);
    const { data } = await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, "base64"));
  }
}

const WALLET_SCRIPT = `(() => {
  const RPC = ${JSON.stringify(RPC)};
  let account = null, chainId = "0x7a69";
  const listeners = { accountsChanged: new Set(), chainChanged: new Set() };
  async function call(method, params) {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params || [] }) });
    const j = await r.json();
    if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; }
    return j.result;
  }
  const provider = {
    isKcTestWallet: true,
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return account ? [account] : [];
      if (method === "eth_chainId") return chainId;
      if (method === "eth_sendTransaction" && window.__kcRejectNext) { window.__kcRejectNext = false; const e = new Error("User rejected the request."); e.code = 4001; throw e; }
      return call(method, params);
    },
    on(e, fn) { listeners[e]?.add(fn); },
    removeListener(e, fn) { listeners[e]?.delete(fn); },
  };
  window.__kcWallet = {
    setAccount(a) { account = a; listeners.accountsChanged.forEach((f) => f(a ? [a] : [])); },
    setChainId(c) { chainId = c; listeners.chainChanged.forEach((f) => f(c)); },
  };
  // Two announced providers (same backend) so the app must show its wallet picker.
  const infos = [
    Object.freeze({ uuid: "kc-e2e-test-wallet-a", name: "KC E2E test wallet A", icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", rdns: "test.kc.e2e.a" }),
    Object.freeze({ uuid: "kc-e2e-test-wallet-b", name: "KC E2E test wallet B", icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", rdns: "test.kc.e2e.b" }),
  ];
  window.addEventListener("eip6963:requestProvider", () => infos.forEach((info) => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }))));
})();`;

async function launchChrome({ webgl }) {
  const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chrome) throw new Error("No Chrome/Chromium found; set CHROME_PATH.");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "kc-chrome-profile-"));
  const args = [
    "--headless=new", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
    "--metrics-recording-only", "--disable-domain-reliability", "--disable-client-side-phishing-detection",
    "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>;127.0.0.1;localhost",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
    "--window-size=1280,900",
    // CI only: disposable runners whose AppArmor policy blocks the Chrome sandbox.
    ...(process.env.KC_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
    ...(webgl ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : ["--disable-gpu", "--disable-webgl", "--disable-3d-apis"]),
    "about:blank",
  ];
  const proc = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
  children.push(proc);
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buf);
      if (m) resolve(m[1]);
    });
    setTimeout(() => reject(new Error("Chrome did not start")), 20000);
  });
  const port = new URL(wsUrl).port;
  const targets = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === "page"), { label: "page target" });
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const page = new Page(ws);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  page.on("Fetch.requestPaused", ({ requestId, request }) => {
    const host = new URL(request.url).hostname;
    if (["127.0.0.1", "localhost"].includes(host) || request.url.startsWith("data:")) {
      page.send("Fetch.continueRequest", { requestId }).catch(() => {});
    } else {
      blocked.push(request.url);
      page.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
    }
  });
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: WALLET_SCRIPT });
  return { page, proc };
}

async function open(page, route) {
  await page.send("Page.navigate", { url: APP + route });
  await waitFor(() => page.eval("document.readyState === 'complete'"), { label: "load" });
}

async function axeCheck(page, label) {
  if (!(await page.eval("typeof window.axe === 'object'"))) await page.eval(AXE_SOURCE);
  const r = await page.eval(`axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } })
    .then((r) => ({ violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 4).map((n) => n.target.join(" ")) })),
                    incomplete: r.incomplete.map((v) => ({ id: v.id, nodes: v.nodes.length })) }))`);
  axeResults.push({ label, ...r });
  // Rendered-text presentation check on the same states. Wallet names and campaign names or
  // descriptions are externally controlled; the harness uses test data without such punctuation,
  // so this check covers the application's own copy.
  const found = await page.eval(`(() => { const t = document.body.innerText; return [";", "\u2014"].filter((c) => t.includes(c)).map((c) => c === ";" ? "semicolon" : "em dash"); })()`);
  punctuationResults.push({ label, found });
  log(`axe ${label}: ${r.violations.length} violation type(s)${r.violations.length ? " -> " + r.violations.map((v) => `${v.id}(${v.impact},${v.nodes})`).join(", ") : ""}`);
  return r;
}

async function connectAs(page, account) {
  await page.eval(`window.__kcWallet.setAccount(${JSON.stringify(account)})`);
  if (await page.exists('[data-testid="connect-wallet"]')) {
    await page.click('[data-testid="connect-wallet"]');
    await waitFor(() => page.exists('[data-testid="wallet-picker"]'), { label: "wallet picker" });
    await page.click('[data-testid="wallet-option-0"]');
  }
  await waitFor(() => page.eval(`document.querySelector('[data-testid="wallet-connected"] code')?.title === ${JSON.stringify(account)}`), { label: `connected ${account}` });
  await waitFor(() => page.eval(`!document.querySelector('[data-testid="network-banner"]')`), { label: "network ok" });
}

async function main() {
  log("output:", OUT);
  if (!(await portFree(RPC)) || !(await portFree(APP))) throw new Error("Ports 8547/4174 must be free.");
  let node = startNode();
  await waitFor(() => rpc("eth_chainId"), { label: "node" });
  run(bin("hardhat"), ["run", "scripts/deploy.js", "--network", NETWORK], contractsDir);
  run("npm", ["run", "compile"], root);
  run("npm", ["run", "build", "-w", "frontend"], root);
  const bundle = fs.readdirSync(path.join(frontendDir, "dist", "assets")).filter((f) => f.endsWith(".js")).map((f) => fs.readFileSync(path.join(frontendDir, "dist", "assets", f), "utf8")).join("\n");
  const leaked = ["kc-e2e-test-wallet", "KC E2E test wallet", "__kcWallet", "__kcRejectNext", "hardhat_setStorageAt", "evm_increaseTime", "isKcTestWallet"].filter((m) => bundle.includes(m));
  record("Production bundle contains no test-only wallet or test RPC code", leaked.length === 0, leaked.join(", ") || "none found");
  const preview = spawn(bin("vite"), ["preview", "--port", "4174"], { cwd: frontendDir, env: { ...env, KC_DEPLOYMENT_NETWORK: NETWORK }, stdio: "ignore" });
  children.push(preview);
  await waitFor(async () => (await fetch(APP)).ok, { label: "preview" });
  const [OWNER, ALICE, BOB, CAROL] = (await rpc("eth_accounts")).map((a) => a);
  const checksum = async (a) => (await import("ethers")).getAddress(a);
  const [owner, alice, bob, carol] = await Promise.all([OWNER, ALICE, BOB, CAROL].map(checksum));

  // ---------------- run 1: WebGL disabled
  const { page, proc } = await launchChrome({ webgl: false });
  await open(page, "/");
  await waitFor(() => page.exists('[data-testid="hero-static"]'), { label: "static hero" });
  record("No-WebGL: app shell and static hero render", await page.exists('[data-testid="hero-static"]') && !(await page.exists('[data-testid="hero-3d"]')));
  await waitFor(() => page.exists('[data-testid="empty-state"]'), { label: "empty campaigns" });
  record("Discovery: empty state before any campaign", true);
  const examplesHome = await page.eval(`(() => {
    const sec = document.querySelector('[data-testid="example-campaigns"]');
    if (!sec) return { ok: false, why: "missing" };
    const cards = [...sec.querySelectorAll("article")];
    const labelled = cards.every((c) => c.querySelector(".badge-example")?.textContent.trim() === "Example");
    const controls = sec.querySelectorAll("button, a, input, textarea, select, form").length;
    const inLive = !!document.querySelector('[data-testid="campaign-grid"] .example-card');
    const disclaimer = sec.textContent.includes("not on-chain campaigns and do not involve real transactions");
    return { ok: cards.length === 3 && labelled && controls === 0 && !inLive && disclaimer, cards: cards.length, labelled, controls, inLive, disclaimer };
  })()`);
  record("Example campaigns: 3 labelled, disclaimer shown, no actions, separate from live (disconnected, no campaigns)", examplesHome.ok, examplesHome);
  await axeCheck(page, "home (disconnected, empty, no WebGL)");
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  const focus = await page.eval(`(() => { const a = document.activeElement; const cs = getComputedStyle(a); return { cls: a.className, outline: cs.outlineStyle, left: a.getBoundingClientRect().left }; })()`);
  record("Keyboard: first Tab focuses the visible skip link with a focus outline", focus.cls === "skip-link" && focus.outline !== "none" && focus.left >= 0, JSON.stringify(focus));

  // Wallet selection with two announced providers
  await page.eval(`window.__kcWallet.setAccount(${JSON.stringify(alice)})`);
  await page.click('[data-testid="connect-wallet"]');
  await waitFor(() => page.exists('[data-testid="wallet-picker"]'), { label: "picker" });
  const names = await page.eval(`[...document.querySelectorAll('[data-testid^="wallet-option-"]')].map((b) => b.textContent)`);
  const firstFocused = await page.eval(`document.activeElement?.dataset?.testid`);
  await axeCheck(page, "wallet picker dialog");
  await page.eval(`document.querySelector('[data-testid="wallet-picker"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await waitFor(() => page.eval(`!document.querySelector('[data-testid="wallet-picker"]')`), { label: "picker closed" });
  const stillDisconnected = await page.exists('[data-testid="connect-wallet"]');
  record("Wallet picker: two providers listed, focus on first option, Escape cancels without connecting", names.length === 2 && firstFocused === "wallet-option-0" && stillDisconnected, names.join(" | "));
  await page.go("/transparency");
  await waitFor(() => page.eval(`document.querySelector('[data-testid="verification"] h2')?.textContent.includes("verified")`), { label: "verified" });
  const checks = await page.eval(`[...document.querySelectorAll('.checks li')].map((l) => l.className)`);
  record("Deployment verification: all checks pass in the browser", checks.length >= 9 && checks.every((c) => c === "check-ok"), `${checks.length} checks`);

  await connectAs(page, alice);
  record("Wallet: EIP-6963 test wallet connects", true, alice);
  await page.go("/tokens");
  await page.type('[data-testid="eth-input"]', "10");
  await page.click('[data-testid="buy-button"]');
  let t = await page.tx("Buy KT");
  record("Token purchase confirmed and verified (alice, 10 ETH -> 1000 KT)", t.state === "confirmed", t.state);
  await waitFor(() => page.eval(`document.querySelector('[data-testid="kt-balance"]')?.textContent === "1000 KT"`), { label: "kt balance" });
  await axeCheck(page, "get KT (connected, confirmed purchase status)");
  await page.go("/create");
  await page.type('[data-testid="name-input"]', "x".repeat(70));
  await page.type('[data-testid="goal-input"]', "0");
  await waitFor(() => page.exists(".field-error"), { label: "validation errors" });
  await axeCheck(page, "create campaign (validation errors shown)");
  await page.type('[data-testid="name-input"]', "");

  await page.go("/create");
  await page.type('[data-testid="name-input"]', "E2E Garden ☀");
  await page.type('[data-testid="description-input"]', "Browser lifecycle check");
  await page.type('[data-testid="goal-input"]', "100");
  await page.type('[data-testid="days-input"]', "0");
  await page.type('[data-testid="minutes-input"]', "2");
  await page.click('[data-testid="create-button"]');
  t = await page.tx("Create campaign");
  const createdHref = await page.eval(`document.querySelector('[data-testid="created-link"] a')?.getAttribute("href")`);
  record("Campaign creation confirmed; id from verified event", t.state === "confirmed" && createdHref === "/campaigns/1", createdHref);
  await page.screenshot("demo-02-create-confirmed");

  await connectAs(page, bob);
  await page.go("/tokens");
  await page.type('[data-testid="eth-input"]', "5");
  await page.click('[data-testid="buy-button"]');
  t = await page.tx("Buy KT");
  record("Account switch: purchase attributed to bob", t.state === "confirmed" && t.text.includes(bob.slice(0, 6)), t.state);

  await page.go("/campaigns/1");
  await page.type('[data-testid="contribution-input"]', "150");
  await page.click('[data-testid="approve-button"]');
  t = await page.tx("Approve KT allowance");
  record("Explicit exact approval confirmed", t.state === "confirmed", t.state);
  await waitFor(() => page.exists('[data-testid="contribute-button"]'), { label: "contribute button" });
  await page.click('[data-testid="contribute-button"]');
  t = await page.tx("Contribute to campaign #1");
  record("Contribution confirmed and verified", t.state === "confirmed", t.state);
  await waitFor(() => page.eval(`document.querySelector('[data-testid="my-contribution"]')?.textContent === "150 KT"`), { label: "recorded contribution" });
  record("Recorded contribution shown from contract state", true);
  await page.screenshot("demo-03-contribution-confirmed");
  await axeCheck(page, "campaign detail (open, contributed)");

  await rpc("evm_increaseTime", [130]);
  await rpc("evm_mine");
  await connectAs(page, carol);
  await page.go("/");
  await page.go("/campaigns/1");
  await page.click('[data-testid="finalize-button"]');
  t = await page.tx("Finalize campaign #1");
  record("Permissionless finalization confirmed (carol)", t.state === "confirmed", t.state);
  await waitFor(() => page.eval(`document.querySelector('[data-testid="campaign-detail"] .badge')?.textContent === "Successful"`), { label: "successful badge" });

  await connectAs(page, alice);
  await page.go("/");
  await page.go("/campaigns/1");
  await page.click('[data-testid="claim-payout-button"]');
  t = await page.tx("Claim creator payout");
  await page.screenshot("demo-04-successful-payout");
  record("Creator payout confirmed (148.5 KT)", t.state === "confirmed" && (await page.exists('[data-testid="payout-claimed"]')) !== null, t.state);

  await connectAs(page, owner);
  await page.go("/account");
  await waitFor(() => page.eval(`document.querySelector('[data-testid="owner-fees"]')?.textContent === "1.5 KT"`), { label: "owner fees" });
  await page.click('[data-testid="claim-fees-button"]');
  t = await page.tx("Claim platform fees");
  record("Owner platform-fee claim confirmed (1.5 KT, on-chain ownership)", t.state === "confirmed", t.state);
  await axeCheck(page, "my account (owner)");
  await page.screenshot("demo-05-owner-fees");
  await page.go("/transparency");
  await waitFor(() => page.exists('[data-testid="solvency-panel"]'), { label: "solvency panel" });
  await axeCheck(page, "transparency (solvent)");
  await page.go("/");
  await waitFor(() => page.exists('[data-testid="campaign-card-1"]'), { label: "home card" });
  await page.screenshot("demo-01-home-campaigns");
  await page.go("/transparency");
  await waitFor(() => page.exists('[data-testid="solvency-panel"]'), { label: "solvency panel again" });
  await page.screenshot("demo-06-transparency");
  await connectAs(page, bob);
  await page.go("/");
  await page.go("/account");
  await waitFor(() => page.exists('[data-testid="not-manager-owner"]'), { label: "non-owner view" });
  record("Owner controls hidden for a non-owner account", !(await page.exists('[data-testid="claim-fees-button"]')));

  // Failed lifecycle with full refund
  await connectAs(page, alice);
  await page.go("/create");
  await page.type('[data-testid="name-input"]', "E2E Too ambitious");
  await page.type('[data-testid="goal-input"]', "1000");
  await page.type('[data-testid="days-input"]', "0");
  await page.type('[data-testid="minutes-input"]', "1");
  await page.click('[data-testid="create-button"]');
  t = await page.tx("Create campaign");
  record("Second campaign created", t.state === "confirmed", t.state);
  await connectAs(page, bob);
  await page.go("/campaigns/2");
  await page.type('[data-testid="contribution-input"]', "30");
  await page.click('[data-testid="approve-button"]');
  await page.tx("Approve KT allowance");
  await page.click('[data-testid="contribute-button"]');
  t = await page.tx("Contribute to campaign #2");
  record("Contribution to failing campaign confirmed", t.state === "confirmed", t.state);
  await rpc("evm_increaseTime", [70]);
  await rpc("evm_mine");
  await page.go("/");
  await page.go("/campaigns/2");
  await page.click('[data-testid="finalize-button"]');
  t = await page.tx("Finalize campaign #2");
  await waitFor(() => page.eval(`document.querySelector('[data-testid="campaign-detail"] .badge')?.textContent === "Failed"`), { label: "failed badge" });
  record("Failed outcome finalized", t.state === "confirmed", t.state);
  await page.go("/account");
  await page.click('[data-testid="refund-2"]');
  t = await page.tx("Claim refund");
  record("Full refund confirmed (30 KT) from the account view", t.state === "confirmed", t.state);
  await page.screenshot("demo-07-failed-refund");

  // Browser-level insolvency (TEST-ONLY state write through the Hardhat RPC; no app hook exists).
  const { ethers } = await import("ethers");
  const manifest = JSON.parse(fs.readFileSync(path.join(contractsDir, "deployments", `${NETWORK}.json`), "utf8"));
  const tokenAddr = manifest.contracts.KreativeToken.address;
  const managerAddr = manifest.contracts.CampaignManager.address;
  await connectAs(page, alice);
  await page.go("/create");
  await page.type('[data-testid="name-input"]', "E2E Insolvency");
  await page.type('[data-testid="goal-input"]', "1000");
  await page.type('[data-testid="days-input"]', "0");
  await page.type('[data-testid="minutes-input"]', "1");
  await page.click('[data-testid="create-button"]');
  await page.tx("Create campaign");
  await connectAs(page, bob);
  await page.go("/campaigns/3");
  await page.type('[data-testid="contribution-input"]', "10");
  await page.click('[data-testid="approve-button"]');
  await page.tx("Approve KT allowance");
  await page.click('[data-testid="contribute-button"]');
  t = await page.tx("Contribute to campaign #3");
  const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [managerAddr, 0]));
  const held = BigInt(await rpc("eth_getStorageAt", [tokenAddr, slot, "latest"]));
  await rpc("hardhat_setStorageAt", [tokenAddr, slot, ethers.toBeHex(held - 4n * 10n ** 18n, 32)]);
  await rpc("evm_mine");
  await page.go("/");
  await page.go("/campaigns/3");
  await waitFor(() => page.exists('[data-testid="insolvency-notice"]'), { timeout: 20000, label: "insolvency notice" });
  await page.type('[data-testid="contribution-input"]', "1");
  const contribBlocked = await page.eval(`(() => { const b = document.querySelector('[data-testid="approve-button"],[data-testid="contribute-button"]'); return !!b && b.disabled; })()`);
  record("Insolvency: notice shown and contributions unavailable", t.state === "confirmed" && contribBlocked);
  await axeCheck(page, "campaign detail (insolvent)");
  await page.screenshot("demo-08-insolvency-test-only");
  await page.go("/transparency");
  await waitFor(() => page.eval(`document.querySelector('[data-testid="sp-status"]')?.textContent === "INSOLVENT"`), { label: "insolvent status" });
  record("Insolvency: monitoring remains available (status INSOLVENT, shortfall 4 KT)", (await page.text(".facts")) !== null && (await page.eval(`document.body.textContent.includes("Shortfall") && document.body.textContent.includes("4 KT")`)));
  await rpc("evm_increaseTime", [70]);
  await rpc("evm_mine");
  await page.go("/campaigns/3");
  await page.click('[data-testid="finalize-button"]');
  t = await page.tx("Finalize campaign #3");
  await waitFor(() => page.exists('[data-testid="claim-refund-button"]'), { label: "refund button" });
  const refundBlocked = await page.eval(`document.querySelector('[data-testid="claim-refund-button"]').disabled`);
  record("Insolvency: finalization works; refund claim unavailable while insolvent", t.state === "confirmed" && refundBlocked, t.state);
  const data = new ethers.Interface(["function transfer(address,uint256)"]).encodeFunctionData("transfer", [managerAddr, 4n * 10n ** 18n]);
  await rpc("eth_sendTransaction", [{ from: alice, to: tokenAddr, data }]); // direct transfer restores backing
  await waitFor(() => page.eval(`!document.querySelector('[data-testid="insolvency-notice"]') && document.querySelector('[data-testid="claim-refund-button"]') && !document.querySelector('[data-testid="claim-refund-button"]').disabled`), { timeout: 20000, label: "claims available again" });
  await page.click('[data-testid="claim-refund-button"]');
  t = await page.tx("Claim refund");
  record("Insolvency: restoring backing re-enables the full refund automatically (10 KT)", t.state === "confirmed", t.state);

  // Wallet rejection
  await page.go("/tokens");
  await page.type('[data-testid="eth-input"]', "1");
  await page.eval("window.__kcRejectNext = true");
  await page.click('[data-testid="buy-button"]');
  t = await page.tx("Buy KT");
  record("Wallet rejection reported as rejected (no success)", t.state === "rejected", t.state);

  // Wrong network
  await page.eval(`window.__kcWallet.setChainId("0x1")`);
  await waitFor(() => page.exists('[data-testid="network-banner"]'), { label: "network banner" });
  await page.type('[data-testid="eth-input"]', "1");
  record("Wrong network: banner shown and purchase disabled", await page.eval(`document.querySelector('[data-testid="buy-button"]').disabled`));
  await axeCheck(page, "get KT (wrong network banner)");
  await page.screenshot("demo-09-wrong-network");
  await page.eval(`window.__kcWallet.setChainId("0x7a69")`);
  await page.screenshot("02-account-flows");

  // Stale chain: restart the node without redeploying
  node.kill();
  await waitFor(async () => portFree(RPC), { label: "node stopped" });
  node = startNode();
  await waitFor(() => rpc("eth_chainId"), { label: "node restarted" });
  await waitFor(() => page.eval(`document.querySelector('[data-testid="deployment-banner"]')?.textContent.includes("Stale")`), { timeout: 40000, label: "stale banner" });
  // With an unverified deployment the purchase form is replaced by the "data unavailable" notice.
  await waitFor(() => page.exists('[data-testid="data-unavailable"]'), { label: "data unavailable" });
  const staleDisabled = await page.eval(`!document.querySelector('[data-testid="buy-button"]') || document.querySelector('[data-testid="buy-button"]').disabled`);
  record("Stale deployment detected after node restart; writes unavailable", staleDisabled);
  await axeCheck(page, "get KT (stale deployment banner, data unavailable)");
  await page.screenshot("demo-10-stale-deployment");
  await page.go("/");
  await waitFor(() => page.exists('[data-testid="data-unavailable"]'), { label: "home data unavailable" });
  const examplesStale = await page.eval(`(() => {
    const sec = document.querySelector('[data-testid="example-campaigns"]');
    if (!sec) return { ok: false, why: "missing" };
    const cards = [...sec.querySelectorAll("article")];
    const labelled = cards.every((c) => c.querySelector(".badge-example")?.textContent.trim() === "Example");
    const controls = sec.querySelectorAll("button, a, input, textarea, select, form").length;
    const inLive = !!document.querySelector('[data-testid="campaign-grid"] .example-card');
    const disclaimer = sec.textContent.includes("not on-chain campaigns and do not involve real transactions");
    return { ok: cards.length === 3 && labelled && controls === 0 && !inLive && disclaimer, cards: cards.length, labelled, controls, inLive, disclaimer };
  })()`);
  record("Example campaigns remain available while live chain data is unavailable", examplesStale.ok, examplesStale);
  proc.kill();

  // ---------------- run 2: WebGL available (software)
  run(bin("hardhat"), ["run", "scripts/deploy.js", "--network", NETWORK], contractsDir);
  const second = await launchChrome({ webgl: true });
  await open(second.page, "/");
  // The static hero is the Suspense fallback while the lazy three.js chunk loads; wait for 3D.
  const hero = await waitFor(async () => ((await second.page.exists('[data-testid="hero-3d"]')) ? "3d" : null), { timeout: 15000, label: "3D hero" }).catch(() => "static");
  record("WebGL available: 3D hero renders (lazy chunk)", hero === "3d", hero);
  await second.page.screenshot("demo-00-home-webgl");
  await axeCheck(second.page, "home (WebGL hero)");
  await second.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await open(second.page, "/");
  await waitFor(() => second.page.exists('[data-testid="hero-static"]'), { label: "static hero (reduced motion)" });
  const anim = await second.page.eval(`getComputedStyle(document.querySelector(".glow-text")).animationName`);
  record("Reduced motion: static hero and no glow animation", !(await second.page.exists('[data-testid="hero-3d"]')) && anim === "none", anim);
  await second.page.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await open(second.page, "/");
  await waitFor(() => second.page.exists(".nav-toggle"), { label: "mobile nav" });
  const navHidden = await second.page.eval(`getComputedStyle(document.querySelector("#primary-nav")).display === "none"`);
  await second.page.click(".nav-toggle");
  const navOpen = await second.page.eval(`document.querySelector(".nav-toggle").getAttribute("aria-expanded") === "true" && getComputedStyle(document.querySelector("#primary-nav")).display !== "none"`);
  const overflow = await second.page.eval(`document.documentElement.scrollWidth <= window.innerWidth + 1`);
  record("Mobile viewport: collapsible navigation with aria-expanded; no horizontal overflow", navHidden && navOpen && overflow, JSON.stringify({ navHidden, navOpen, overflow }));
  await axeCheck(second.page, "home (mobile 375px, menu open, reduced motion)");
  await second.page.screenshot("demo-11-mobile");
  second.proc.kill();

  record("No non-loopback request reached the network (Fetch interception)", blocked.length === 0, blocked.length ? blocked.join(", ") : "0 blocked attempts");
  const punctuationHits = punctuationResults.filter((r) => r.found.length);
  record(`Presentation: no em dashes or semicolons in rendered application text (${punctuationResults.length} states)`, punctuationHits.length === 0, punctuationHits.length ? punctuationHits : "none found");
  const axeViolations = axeResults.reduce((n, r) => n + r.violations.length, 0);
  record(`Automated accessibility (axe-core ${JSON.parse(fs.readFileSync(path.join(root, "node_modules", "axe-core", "package.json"), "utf8")).version}): no violations across ${axeResults.length} routes/states`, axeViolations === 0, `${axeViolations} violation type(s)`);
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  record("harness", false, e.message);
} finally {
  for (const c of children) c.kill();
  const summary = { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results, blockedRequests: blocked, accessibility: axeResults };
  fs.writeFileSync(path.join(OUT, "browser-check.json"), JSON.stringify(summary, null, 2));
  log(`${summary.passed} passed, ${summary.failed} failed; report: ${path.join(OUT, "browser-check.json")}`);
  process.exitCode = failed || summary.failed ? 1 : 0;
}
