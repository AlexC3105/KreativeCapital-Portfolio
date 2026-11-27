// Regression tests for scripts/check-repo-policy.mjs (node:test, no dependencies).
// Every fixture value is SYNTHETIC and non-functional, assembled at runtime so that this file
// itself contains no matchable literal (the tracked-mode scan also reads this file).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scan, pngMetadataChunks } from "../check-repo-policy.mjs";

const HEX32 = "ab".repeat(32); // synthetic 32-byte value, not a real key
// All fixtures of one run live under a single parent in the OS temp directory (one folder per
// run, not one per test). The tests never delete directories; the OS temp area is cleaned by the
// system.
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "kc-policy-test-"));
const fixtureRoot = () => fs.mkdtempSync(path.join(RUN_ROOT, "case-"));

function tree(files, extra = () => {}) {
  const root = fixtureRoot();
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  extra(root);
  return scan({ root, mode: "dir" }).problems;
}
const flags = (problems, file, what) => problems.some((p) => p.startsWith(file) && p.includes(what));

test("a clean tree passes", () => {
  assert.deepEqual(tree({ "src/app.js": "export const x = 1;\n", "README.md": "# Demo\n" }), []);
});

test("bare private-key-shaped literals are detected (prefixed and quoted)", () => {
  const p = tree({ "a.js": `const k = "0x${HEX32}";\n`, "b.js": `const k = '${HEX32}';\n` });
  assert.ok(flags(p, "a.js", "32-byte hex literal"));
  assert.ok(flags(p, "b.js", "32-byte hex string"));
});

test("Hardhat account credential arrays and the development mnemonic are detected", () => {
  const p = tree({
    "hardhat.config.js": `module.exports = { networks: { x: { accounts: ["0x${"cd".repeat(20)}"] } } };\n`,
    "seed.txt": Array(11).fill("test").join(" ") + " junk\n",
    "cfg.js": `const mnemonic = "${Array(12).fill("alpha").join(" ")}";\n`,
  });
  assert.ok(flags(p, "hardhat.config.js", "account credential array"));
  assert.ok(flags(p, "seed.txt", "development mnemonic"));
  assert.ok(flags(p, "cfg.js", "mnemonic"));
});

test("personal paths are detected: macOS (any case), Linux and Windows; relative imports are not", () => {
  const p = tree({
    "mac.md": "see " + "/Users/" + "Alex" + "/project\n",
    "linux.md": "see " + "/home/" + "alex" + "/project\n",
    "win.md": "see C:" + "\\Users\\" + "Alex" + "\\project\n",
    "ok.js": "import Home from './pages/Home/Home';\n",
  });
  assert.ok(flags(p, "mac.md", "home-directory path"));
  assert.ok(flags(p, "linux.md", "home-directory path"));
  assert.ok(flags(p, "win.md", "Windows"));
  assert.ok(!p.some((x) => x.startsWith("ok.js")));
});

test("GitHub token formats and credential assignments are detected", () => {
  const p = tree({
    "t1.txt": "token " + "github_pat_" + "A1".repeat(15) + "\n",
    "t2.txt": "token " + "ghp_" + "B2".repeat(18) + "\n",
    "t3.js": `const password = "${"x".repeat(12)}";\n`,
  });
  assert.ok(flags(p, "t1.txt", "fine-grained personal access token"));
  assert.ok(flags(p, "t2.txt", "GitHub token"));
  assert.ok(flags(p, "t3.js", "credential assignment"));
});

test("every .env variant and .envrc are prohibited files", () => {
  const files = [".env", ".env.example", ".env.local", ".envrc", "config/prod.env", "frontend/.env.development"];
  const p = tree(Object.fromEntries(files.map((f) => [f, "X=1\n"])));
  for (const f of files) assert.ok(flags(p, f, "environment file"), f);
});

test("logs, conflict copies, node_modules, generated output, wallet files and assistant configuration are detected", () => {
  const p = tree(
    {
      "debug.log": "x\n",
      "src/app 2.js": "x\n",
      "notes (conflicted copy).md": "x\n",
      "frontend/dist/index.html": "x\n",
      "contracts/artifacts/a.json": "{}\n",
      "frontend/src/abi/KreativeToken.json": "{}\n",
      "contracts/deployments/localhost.json": "{}\n",
      "keys/UTC--2026-01-01T00-00-00Z--abc": "{}\n",
      "wallet.json": "{}\n",
      "CLAUDE.md": "x\n",
      ".claude/settings.json": "{}\n",
    },
    (root) => {
      fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
      fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "x\n");
    }
  );
  for (const [f, what] of [
    ["debug.log", "log file"],
    ["src/app 2.js", "conflict copy"],
    ["notes (conflicted copy).md", "conflict copy"],
    ["frontend/dist/index.html", "generated output"],
    ["contracts/artifacts/a.json", "generated output"],
    ["frontend/src/abi/KreativeToken.json", "generated ABI"],
    ["contracts/deployments/localhost.json", "deployment manifest"],
    ["keys/UTC--2026-01-01T00-00-00Z--abc", "wallet or keystore"],
    ["wallet.json", "wallet or keystore"],
    ["CLAUDE.md", "assistant configuration"],
    [".claude/settings.json", "assistant configuration"],
    ["node_modules/", "node_modules"],
  ]) {
    assert.ok(flags(p, f, what), `${f}: ${what}`);
  }
  assert.ok(!p.some((x) => x.startsWith("node_modules/pkg")), "node_modules contents are not walked");
});

test("symbolic links are reported and never followed, including links escaping the root", () => {
  const outside = fixtureRoot();
  fs.writeFileSync(path.join(outside, "secret.txt"), `0x${HEX32}\n`);
  const p = tree({ "a.txt": "x\n" }, (root) => {
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    fs.symlinkSync(outside, path.join(root, "linkdir"));
  });
  assert.ok(flags(p, "link.txt", "symbolic link"));
  assert.ok(flags(p, "linkdir", "symbolic link"));
  assert.ok(!p.some((x) => x.includes("hex")), "link targets are not read");
});

test("PNG text/metadata chunks are detected", () => {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
  };
  const sig = Buffer.from("89504e470d0a1a0a", "hex");
  const clean = Buffer.concat([sig, chunk("IHDR", Buffer.alloc(13)), chunk("IDAT", Buffer.alloc(2)), chunk("IEND", Buffer.alloc(0))]);
  const tagged = Buffer.concat([sig, chunk("IHDR", Buffer.alloc(13)), chunk("tEXt", Buffer.from("Comment\0x")), chunk("IEND", Buffer.alloc(0))]);
  assert.deepEqual(pngMetadataChunks(clean), []);
  assert.deepEqual(pngMetadataChunks(tagged), ["tEXt"]);
  const p = tree({}, (root) => {
    fs.writeFileSync(path.join(root, "clean.png"), clean);
    fs.writeFileSync(path.join(root, "tagged.png"), tagged);
  });
  assert.ok(flags(p, "tagged.png", "image metadata"));
  assert.ok(!p.some((x) => x.startsWith("clean.png")));
});

test("exclusions stay narrow: same rule elsewhere in the file, or in another file, is still flagged", () => {
  const email = "someone" + "@" + "personal.test";
  const p = tree({
    "package-lock.json": `{\n  "deprecated": "contact ${email}",\n  "author": "${email}"\n}\n`,
    "other/package-lock.json": `{ "deprecated": "contact ${email}" }\n`,
  });
  assert.ok(p.includes("package-lock.json:3: email address (personal contact information)"));
  assert.ok(!p.includes("package-lock.json:2: email address (personal contact information)"));
  assert.ok(flags(p, "other/package-lock.json", "email address"));
});

test("legitimate public values are not flagged: lockfile integrity, 20-byte addresses, short hashes", () => {
  const p = tree({
    "lock.json": `{ "integrity": "sha512-${"Q".repeat(86)}==" }\n`,
    "addr.js": `export const TOKEN = "0x${"5f".repeat(20)}";\n`,
    "short.js": `const h = "0x${"12".repeat(16)}";\n`,
  });
  assert.deepEqual(p, []);
});

test("problem reports never include the matched value", () => {
  const p = tree({ "a.js": `const k = "0x${HEX32}";\n` });
  assert.ok(p.length > 0);
  assert.ok(p.every((x) => !x.includes(HEX32)));
});
