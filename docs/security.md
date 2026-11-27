# Security notes

> **Educational, unaudited code for a local development chain.** KreativeCapital has not had
> an independent security audit, is not production software, and must not be deployed to a
> public network or used with real funds. KT has no value, no redemption rights and no backing.

## Design safeguards

**Contracts**
- Checks-effects-interactions, plus `nonReentrant` on every function that transfers value.
- `SafeERC20` with an exact-receipt check on contributions.
- Pull-based settlement: each payout goes only to the entitled caller, once.
- A liability ledger (`totalOutstanding`) with a deterministic solvency guard. Contributions and
  claims stop while the balance does not cover recorded liabilities, and resume automatically.
- Narrow owner powers: earned fees and recorded sale proceeds only. There is no escrow
  withdrawal, outcome override, pause, sweep, mint or upgrade path. An ABI surface test
  enforces this. `renounceOwnership` is disabled and ownership transfers take two steps.
- Unsolicited tokens or ETH are never credited to anyone. They are reported and stay locked.

**Frontend**
- Exact `bigint` arithmetic for every financial value.
- The deployment is verified against the chain before any data is trusted: chain id, genesis
  hash, deployment blocks, runtime code hashes, bytecode against the compiled artifacts, and
  wiring.
- An account change in the wallet disables writes at once, and a network change after one
  wallet call. Writes stay disabled until the new context is verified. An action started under
  an older context is refused, never transferred to another account.
- Writes are re-verified when started and again immediately before submission. They are
  refused on a stale deployment, the wrong chain, a same-id different chain, or a changed
  account.
- Requests are pinned to the verified sender, contract and chain id 31337. Whether a wallet
  refuses to sign for another chain is the wallet's behaviour.
- Every call is simulated before the wallet is prompted. Success is reported only when the
  mined transaction matches the request and receipt, event and state agree.
- Uncertain outcomes end as *unknown*. They are never retried automatically and pause that
  section, across page navigation, until it is resolved. A read-only status check resolves it
  only when a late receipt passes the full original verification (or shows a revert). The
  user's own acknowledgement releases the pause but is not proof of success. A full browser
  reload clears the pause.
- Approvals are for the exact amount, never unlimited.
- The app never asks for seed phrases or private keys and never switches to a public network.
- No analytics, telemetry, CDN or remote fonts. The browser harness confirms 0 non-loopback
  requests.

**Repository**
- No `.env` files, keys, mnemonics or credentials. Development accounts come from Hardhat at
  runtime.
- Deployment manifests are generated locally and never committed.
- A policy scanner (`scripts/check-repo-policy.mjs`) runs locally and in CI.
- CI uses read-only permissions, no secrets, `persist-credentials: false`, and actions pinned
  to full commit SHAs.

## Verification performed

| Activity | Result | Limits |
|---|---|---|
| Contract tests (113, including a randomized reference model) | Passing | Tests show the specified behaviour. They cannot prove the absence of defects |
| Slither 0.11.4 static analysis | 7 results, all classified, with no high-impact findings, no confirmed defects and no suppressions | Not an independent audit |
| Frontend unit/UI (107), integration (23), browser (36) | Passing | Test-only wallets. Real wallet-extension testing was deferred by the owner and has not been executed (see [manual-wallet-validation.md](manual-wallet-validation.md)) |
| axe-core accessibility scan (12 states) | 0 violations | Automated checks only. No claim of full WCAG conformance |
| Independent AI-assisted technical reviews (fresh sessions) | Final narrow review: suitable to proceed, after the earlier corrections were applied | Not a professional audit. The coordinating session also implemented the changes. |
| Repository policy scan (12 scanner regression tests) | Passing | Pattern-based guard rail. Not a complete secret scanner |
| Independent secret scan (TruffleHog 3.100.1, provenance verified) | The 101-file publication candidate and its complete Git history, before the push and again on a fresh clone of the GitHub repository: 0 verified findings and 1 unverified finding in each scan. That finding is a synthetic placeholder URL with dummy credentials, in a test that checks the deploy tooling refuses such URLs (a false positive). | Live credential verification and update checks were disabled. The signed checksum and signing-certificate identity were verified, but the Rekor transparency log was not checked. Zero verified findings is not proof that no secrets exist. |
| Hosted CI (GitHub Actions, ubuntu-24.04) | All four jobs passed on the first hosted run ([run 46081091196](https://github.com/AlexC3105/KreativeCapital-Portfolio/actions/runs/46081091196)) | Automated validation only. Nothing is deployed. |

## Residual dependency risk

`npm audit` reports **30 advisories: 0 critical, 2 high, 10 moderate, 18 low**. These are the
13 distinct advisories in the table below. **None is fixed.** Each is already at the newest
version available within the project's supported major versions: Hardhat 2,
OpenZeppelin 4, React 18 and React Router 6. Fixing them would require major migrations
(Hardhat 3, React Router 7), which are out of scope for this release.

The contracts' production dependencies have **0** advisories. The only advisories in the
shipped frontend bundle are two **moderate** react-router advisories, neither reachable in this
app.

**Status:** the project owner has **accepted** all 13 advisories for bounded educational use,
following an independent technical review that supported bounded acceptance within this local
scope. **None is remediated.** The acceptance holds only while the exposure assumptions in the
table remain true and no reassessment trigger occurs. It does not extend to commercial
deployment, production systems or real financial assets.

| Advisory | Package (path) | Exposure | Reachability here | Owner disposition | Reassess when |
|---|---|---|---|---|---|
| GHSA-5c6j-r48x-rmvq (high), GHSA-qj8w-gfj5-8c6v (moderate), GHSA-m5mm-p8h7-m29v (low) | serialize-javascript ← mocha ← hardhat / solidity-coverage | Development and test only | The vulnerable code is imported only by mocha's **parallel-mode** worker files (`lib/nodejs/worker.js`, `buffered-worker-pool.js`). This project never enables parallel mode, so it is not executed. Not shipped. | Accepted (bounded), not fixed | Mocha parallel mode is enabled, or Hardhat supports mocha ≥ 12 |
| GHSA-ph9p-34f9-6g65 (high), GHSA-52f5-9888-hmc6 (low) | tmp ← solc-js ← hardhat | Development only | `tmp` is imported only by solc-js's `smtsolver.js` (the SMT-solver callback). Hardhat compilation does not use it and the project does not use the SMTChecker, so it is not executed | Accepted (bounded), not fixed | The Solidity SMTChecker or solc-js SMT callbacks are used, or a Hardhat 3 migration is approved |
| GHSA-wrjc-x8rr-h8h6 (moderate) | react-router 6.30.6 | **Shipped runtime** | Open redirect via attacker-supplied paths in `<Link>`/`useNavigate`. The app navigates only to fixed internal routes and numeric campaign ids | Accepted (bounded), not fixed | Navigation to user-supplied paths is added, or a fixed 6.x is released |
| GHSA-337j-9hxr-rhxg (moderate) | react-router 6.30.6 | Shipped runtime | Affects server-side `deserializeErrors()`. The app is client-only with no SSR or data-router hydration | Accepted (bounded, not reachable), not fixed | SSR or data-router hydration is introduced |
| GHSA-pxg6-pf52-xh8x (low) | cookie ← @sentry/node ← hardhat | Development only | Hardhat crash reporting. Telemetry consent is never given | Accepted (bounded), not fixed | Telemetry is enabled, or Hardhat upgrades the dependency |
| GHSA-848j-6mx2-7j84 (low) | elliptic ← hardhat toolchain | Development only | Signing with local disposable accounts only | Accepted (bounded), not fixed | The tooling is ever used with keys that protect value (never intended) |
| GHSA-73rr-hh4g-fpgx (low) | diff ← mocha | Development only | Diffs of the project's own test output | Accepted (bounded), not fixed | A compatible mocha release |
| GHSA-378v-28hj-76wf (moderate) | bn.js ← solidity-coverage | Development only | Coverage instrumentation only | Accepted (bounded), not fixed | solidity-coverage update, or coverage tooling removed |
| GHSA-3g3m-2fjr-6pw4, GHSA-g3hv-75wg-m249 (moderate) | glob / minimatch ← mocha, solidity-coverage | Development only | Globbing over the project's own test paths | Accepted (bounded), not fixed | A compatible mocha or solidity-coverage release |

**General reassessment triggers:**
- any new critical or high advisory in the shipped runtime (CI fails on critical)
- any plan to deploy beyond a local development chain
- an approved major-version migration
- mocha parallel mode or the Solidity SMTChecker coming into use (see above).

## Installation and CI exposure

**Install-time scripts.**
- Four dependencies declare install scripts: `esbuild`, `fsevents` (macOS, optional),
  `keccak` and `secp256k1`. All are development dependencies.
- The validated procedure installs from the lockfile **with scripts disabled**
  (`npm ci --ignore-scripts`, then `npm run compile`). CI does the same, and all suites pass
  that way.
- A plain `npm ci` runs those four scripts.

**Untrusted pull requests.**
- CI runs pull-request code with a read-only token (`contents: read`), no secrets and
  `persist-credentials: false`, on disposable runners.
- None of the advisories above increases that exposure.

**Supply chain.**
- Actions are pinned to full commit SHAs.
- The lockfile resolves only to the npm registry.
- No artifacts are uploaded.

## Toolchain integrity

The Node.js 22.23.5 toolchain used for validation was verified as follows:
1. The release signing key was obtained from the official `nodejs/release-keys` repository.
2. Its full fingerprint (`5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`) matches both the
   `keys.list` in that repository and the release-key list in the `nodejs/node` README.
3. The clearsigned `SHASUMS256.txt.asc` from nodejs.org was **cryptographically verified**
   with that key (OpenPGP.js 6.3.2, run in an isolated temporary workspace). A tampered copy
   was rejected.
4. The archive's SHA-256 matches the authenticated checksum.
5. The installed toolchain is file-for-file identical to the verified archive.

## Reporting a problem

This is a portfolio project, not a maintained product. If you notice a security issue, please
open a GitHub issue that describes the class of problem. Do not include exploit code or any
real keys.
