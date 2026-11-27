#!/usr/bin/env node
// Repository policy scan (no dependencies). Fails on prohibited files or credential-like content.
//   node scripts/check-repo-policy.mjs            # scan files tracked by git
//   node scripts/check-repo-policy.mjs --dir DIR  # scan a directory tree (e.g. an allowlisted
//                                                 # export); run it BEFORE installing or building
// It is a guard rail, not a complete secret scanner: it matches known patterns line by line,
// does not decode or de-obfuscate content, and does not scan Git history. Use an independent
// secret scanner as the release gate. Regression tests: scripts/test/check-repo-policy.test.mjs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Path rules: [regex on the repository-relative POSIX path, description]. */
export const PATH_RULES = [
  [/(^|\/)\.env[^/]*$/i, "environment file (.env, .env.*, .envrc)"],
  [/(^|\/)[^/]+\.env$/i, "environment file (*.env)"],
  [/(^|\/)[^/]*\.(pem|key|p12|pfx|keystore|jks|asc|gpg|kdbx)$/i, "key, certificate or keyring file"],
  [/(^|\/)id_(rsa|dsa|ed25519|ecdsa)(\.pub)?$/, "SSH key file"],
  [/(^|\/)(UTC--[^/]+|wallet\.(json|dat)|[^/]*\.wallet)$/i, "wallet or keystore file"],
  [/(^|\/)contracts\/deployments\//, "local deployment manifest"],
  [/(^|\/)node_modules\//, "installed dependencies (node_modules)"],
  [/(^|\/)(dist|build|coverage|coverage-integration|artifacts|cache|typechain(-types)?|\.coverage_[a-z]+)\//, "generated output"],
  [/(^|\/)frontend\/src\/abi\//, "generated ABI copies"],
  [/(^|\/)coverage\.json$/, "generated coverage output"],
  [/(^|\/)(venv|\.venv)\//, "Python virtual environment"],
  [/\.log$/i, "log file"],
  [/(^|\/)(npm-debug|yarn-error|yarn-debug|pnpm-debug)\.log/i, "log file"],
  [/(^|\/)\.DS_Store$/, "OS metadata"],
  [/(^|\/)Thumbs\.db$/i, "OS metadata"],
  [/(^|\/)[^/]* \d+(\.[^/]*)?$/, "synchronization-conflict copy (\"name 2.ext\")"],
  [/(^|\/)[^/]*\((conflicted copy|conflict)[^/]*\)[^/]*$/i, "synchronization-conflict copy"],
  [/\.(orig|rej|swp)$/, "merge or editor leftover"],
  [/(^|\/)(\.claude\/|CLAUDE\.md$|AGENTS\.md$|\.cursor\/|\.cursorrules$|\.aider|\.windsurf|\.continue\/|\.github\/copilot-instructions\.md$)/, "assistant configuration"],
];

/** Content rules: [regex per line, description]. */
export const CONTENT_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----/, "PEM / PGP private key"],
  [/(?<![0-9a-fA-Fx])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/, "private-key-shaped 32-byte hex literal"],
  [/["'`][0-9a-fA-F]{64}["'`]/, "private-key-shaped 32-byte hex string"],
  [/\baccounts\s*:\s*\[\s*["'`](0x)?[0-9a-fA-F]{16,}/, "Hardhat account credential array"],
  [/\b(private[_-]?key|secret[_-]?key|signing[_-]?key)\b["']?\s*[:=]\s*["'`]?(0x)?[0-9a-fA-F]{32,}/i, "private key assignment"],
  [/\b(mnemonic|seed[_ -]?phrase|recovery[_ -]?phrase)\b["']?\s*[:=]\s*["'`]?[a-z]+( [a-z]+){11,23}/i, "mnemonic / seed phrase"],
  [/\btest( test){10} junk\b/, "well-known Hardhat development mnemonic"],
  [/\b(password|passwd|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["'`][^"'`\s]{8,}["'`]/i, "credential assignment"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/, "GitHub fine-grained personal access token"],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/, "GitLab token"],
  [/\bsk-[A-Za-z0-9_-]{32,}\b/, "API secret key"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, "Slack token"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
  [/(?<![\w.~-])\/(Users|home)\/(?!runner\/|user\/|<)[^/\s"'`]+\//i, "personal home-directory path (macOS/Linux)"],
  [/\b[A-Za-z]:\\{1,2}Users\\{1,2}[^\\\s"'`]+/i, "personal home-directory path (Windows)"],
  [/\b[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com|anthropic\.com|example\.(com|org))[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/, "email address (personal contact information)"],
];

/**
 * Narrow, justified exclusions: [path, rule description, line regex or null, reason]. Each
 * applies to one file and one rule (and, where given, only to lines matching the regex).
 * Never add broad or directory-wide exclusions.
 */
export const EXCLUSIONS = [
  [
    "frontend/legacy-2024/src/pages/AdminControl/AdminControl.js",
    "private-key-shaped 32-byte hex string",
    /correctPinHash/,
    "SHA-256 of a client-side PIN in the quarantined 2024 code; historical, excluded from the public copy",
  ],
  [
    "docs/modernization/stage-6-portfolio.md",
    "private-key-shaped 32-byte hex string",
    /^\| Archive \| `node-v22\.23\.5-darwin-arm64\.tar\.gz` SHA-256 /,
    "published SHA-256 of the official Node.js archive in an internal record (excluded from the public copy)",
  ],
  [
    "package-lock.json",
    "email address (personal contact information)",
    /^\s*"deprecated": "/,
    "npm registry deprecation notices quoting a third-party maintainer's public contact; not project contact information",
  ],
];

const SELF = "scripts/check-repo-policy.mjs";
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|pdf|zip|gz|tgz)$/i;
const PNG_METADATA_CHUNKS = new Set(["tEXt", "iTXt", "zTXt", "eXIf", "tIME"]);

/** PNG chunk types that carry text or metadata (screenshots must have none). */
export function pngMetadataChunks(buf) {
  const sig = "89504e470d0a1a0a";
  if (buf.length < 8 || buf.subarray(0, 8).toString("hex") !== sig) return [];
  const found = [];
  let o = 8;
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString("latin1", o + 4, o + 8);
    if (PNG_METADATA_CHUNKS.has(type)) found.push(type);
    if (type === "IEND") break;
    o += 12 + len;
  }
  return found;
}

/** Tracked mode: git paths plus symlink detection (mode 120000). */
function listTracked(root) {
  const out = execFileSync("git", ["ls-files", "-z", "--stage"], { cwd: root, encoding: "utf8" });
  return out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      return { path: line.slice(tab + 1), symlink: line.startsWith("120000 ") };
    });
}

/** Directory mode: walk without following symbolic links; .git internals are skipped. */
function listDirectory(root) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out.push({ path: p, symlink: true });
      else if (e.isDirectory()) {
        if (e.name === ".git" && rel === "") continue;
        if (e.name === "node_modules") out.push({ path: `${p}/`, dir: true });
        else walk(p);
      } else if (e.isFile()) out.push({ path: p });
      else out.push({ path: p, special: true });
    }
  };
  walk("");
  return out;
}

const excluded = (file, what, line = null) =>
  EXCLUSIONS.some(([f, rule, lineRe]) => f === file && rule === what && (lineRe === null || (line !== null && lineRe.test(line))));

/** Scan and return a list of problems (strings). Never prints matched secret values. */
export function scan({ root, mode }) {
  const entries = mode === "dir" ? listDirectory(root) : listTracked(root);
  const problems = [];
  const realRoot = fs.realpathSync(root);
  for (const entry of entries) {
    const f = entry.path;
    if (f.split("/").includes("..")) {
      problems.push(`${f}: path escapes the scan root`);
      continue;
    }
    if (entry.symlink) {
      problems.push(`${f}: symbolic link (not followed)`);
      continue;
    }
    if (entry.special) {
      problems.push(`${f}: special file`);
      continue;
    }
    for (const [re, what] of PATH_RULES) if (re.test(f) && !excluded(f, what)) problems.push(`${f}: ${what}`);
    if (entry.dir) continue;
    const abs = path.join(root, f);
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch {
      continue; // deleted in the working tree
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      problems.push(`${f}: resolves outside the scan root`);
      continue;
    }
    if (fs.lstatSync(abs).isSymbolicLink()) {
      problems.push(`${f}: symbolic link (not followed)`);
      continue;
    }
    if (/\.png$/i.test(f)) {
      const chunks = pngMetadataChunks(fs.readFileSync(abs));
      if (chunks.length) problems.push(`${f}: image metadata chunks (${chunks.join(", ")})`);
    }
    if (f === SELF || BINARY.test(f)) continue;
    const text = fs.readFileSync(abs, "utf8");
    text.split("\n").forEach((line, i) => {
      for (const [re, what] of CONTENT_RULES) if (re.test(line) && !excluded(f, what, line)) problems.push(`${f}:${i + 1}: ${what}`);
    });
  }
  return { problems, count: entries.length };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const dirIndex = args.indexOf("--dir");
  const mode = dirIndex >= 0 ? "dir" : "tracked";
  const root = dirIndex >= 0 ? path.resolve(args[dirIndex + 1] ?? ".") : process.cwd();
  const { problems, count } = scan({ root, mode });
  if (problems.length) {
    console.error(`Repository policy violations (${problems.length}):\n` + problems.map((p) => `  - ${p}`).join("\n"));
    process.exit(1);
  }
  console.log(`Repository policy: OK (${count} files scanned in ${mode === "dir" ? "directory" : "git-tracked"} mode)`);
}
