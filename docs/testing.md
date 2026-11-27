# Testing

All suites run locally against Hardhat development chains bound to `127.0.0.1`. None needs
secrets, `.env` files or external services. The browser harness blocks every non-loopback
request.

## Summary

| Suite | Command | Scope | Count |
|---|---|---|---|
| Contract tests | `npm run test:contracts` | Smoke, unit (including tooling and adopted review regressions) and randomized reference-model tests (Hardhat in-process network) | 113 |
| Frontend unit/UI | `npm run test:frontend` | Library, provider and UI tests (Vitest + jsdom) | 107 |
| Local-chain integration | `npm run test:integration` | Frontend library against a real Hardhat node on `127.0.0.1:8546` | 23 |
| Browser harness | `npm run e2e:browser` | Real UI in headless Chrome, with the chain on `127.0.0.1:8547` and the preview server on `127.0.0.1:4174` | 36 checks |
| Policy scanner | `npm run test:policy` | Regression tests for `scripts/check-repo-policy.mjs` with synthetic fixtures (`node:test`) | 12 |
| All except the browser harness and policy tests | `npm test` | Compile, then contracts, frontend unit/UI and integration | n/a |

Coverage (measured, not targeted):
- `npm run test:coverage -w frontend` for the frontend
- `npm run coverage -w contracts` for the contracts (solidity-coverage).

## Contract tests (`contracts/test/`)

| Folder | Purpose |
|---|---|
| `smoke/` | Environment checks: compiler settings, local chain and accounts, artifact export, deployment and manifest determinism, refusal to deploy to other chains |
| `unit/` | Rule-by-rule tests for both contracts, including boundaries, failure injection, solvency and the ABI surface |
| `invariants/` | Deterministic randomized sequences checked against an independent reference model (`helpers/model.js`) |

**Revert assertions.** Revert tests assert the specific error:
- custom errors with their arguments where relevant
- OpenZeppelin reason strings for token allowance and balance failures
- `revertedWithoutReason` for plain ETH sent to contracts without a receive function.

State-changing rejections also assert an **unchanged state snapshot**: campaign fields,
contributions and refund flags, `totalOutstanding`, `platformFeesOutstanding`, and the
manager's and caller's KT balances. View-only rejections (for example unknown ids on views)
assert the error alone.

**Reentrancy coverage.**
- `contribute`, `claimCreatorPayout`, `claimRefund` and `claimPlatformFees` are `nonReentrant`,
  as are `buyTokens` and `withdrawProceeds` on the token.
- `createCampaign` and `finalize` are not. `createCampaign` makes only a view call to the token,
  and `finalize` makes no external calls.
- Cross-function reentrancy through a hostile test token is covered both ways:
  - a claim re-entered from `contribute` is blocked
  - `finalize` re-entered from a claim leaves the ledger consistent.

Failure injection uses test-only mocks in `contracts/contracts/test-mocks/`:
- a configurable ERC-20 (returns false, reverts, fee-on-transfer on incoming transfers,
  re-entrant hook)
- an outgoing-fee ERC-20 that documents the canonical-token assumption (see
  [financial-model.md](financial-model.md))
- a contract that rejects ETH.

The mocks are never deployed by the deploy script.

### Test ID scheme

Test titles carry an ID that maps to a rule (`R-…`) in [financial-model.md](financial-model.md)
and [architecture.md](architecture.md).

| Prefix | Area |
|---|---|
| `T-C` | Campaign creation: fields, ids, duplicate names, goal/duration/name/description bounds, unknown ids, self-funding |
| `T-K` | Contributions: zero amount, deadline window, accumulation, over-funding, approvals, exact receipt |
| `T-F` | Finalization: timing, permissionless, once only, outcome rule, no token movement, zero-total campaigns |
| `T-S` | Successful-campaign settlement: fee rounding, creator payout, platform fees |
| `T-R` | Failed-campaign refunds: exact amounts, once only, eligibility, no fee |
| `T-X` | Failure handling: false-returning and reverting transfers, reentrancy, plain ETH rejected |
| `T-A` | Authorization: owner powers, disabled renounce, two-step transfer, ABI surface |
| `T-T` | KreativeToken: supply, price, reserve, recorded proceeds, withdrawal failures |
| `T-G` | Solvency guard: blocked operations, available operations, recovery, error precedence |
| `T-I` | Ledger and accounting invariants checked in targeted scenarios |
| `T-B` | Boundary values: maximum goal, extreme amounts |
| `T-Z` | Randomized reference-model sequences (20 seeds × 200 operations, recorded seeds) |

The matching rule prefixes are:
- `R-C` creation
- `R-K` contributions
- `R-F` finalization
- `R-S` settlement
- `R-R` refunds
- `R-X` failures
- `R-A` authorization
- `R-T` token
- `R-G` solvency.

The randomized suite accepts `KC_FUZZ_SEEDS` and `KC_FUZZ_STEPS` for exploratory runs. The
recorded defaults are what CI and the published counts use.

**Scope of the randomized suite (T-Z01).**
- It runs only the canonical KreativeToken and the public operations: purchases, creations,
  contributions, time jumps, finalizations, payout/refund/fee claims and unsolicited transfers.
- It asserts solvency after every step. It **does not** generate insolvency, use misbehaving
  tokens or transfer ownership.
- Insolvency and recovery are validated by the dedicated solvency tests (T-G), using a
  test-only storage write. Failed and re-entrant transfers use the failure tests (T-X) with
  mocks, and ownership uses the T-A tests.

## Frontend tests (`frontend/test/`)

- **Unit/UI** (`test/unit/`, jsdom):
  - exact unit parsing and formatting
  - manifest validation
  - deployment verification
  - transaction state machine and error decoding
  - wallet discovery and the picker
  - write-context checks
  - duplicate-submission guard
  - every page's validation and states.
- **Integration** (`test/integration/`):
  - starts its own Hardhat node on `127.0.0.1:8546`, deploys, and drives the real library code
    through EIP-1193 adapters
  - full lifecycles, both successful and failed
  - the owner path
  - a stale chain, a same-id different chain, and a bytecode mismatch
  - a network change while a transaction is pending
  - unknown confirmation after a timeout
  - deadline equality
  - pagination
  - test-only insolvency and recovery.

## Browser harness (`frontend/e2e/browser-check.mjs`)

A dependency-free script that drives headless Chrome over the DevTools protocol, using Node's
built-in WebSocket. It starts its own chain (8547) and production preview (4174), so it does
not interfere with a running dev session on 8545/5173.

It covers:
- the empty state
- the wallet picker with two test wallets
- deployment verification
- purchase, creation, account switch, exact approval and contribution
- permissionless finalization, creator payout and owner fees
- hidden owner controls for non-owners
- the failed campaign and full refund
- test-only insolvency and recovery
- wallet rejection
- wrong network and stale deployment
- WebGL and no-WebGL heroes, reduced motion and the mobile layout.

**Isolation:**
- temporary browser profile
- a dead proxy for every non-loopback host, with NOTFOUND resolver rules
- DevTools request interception, which must record **0** blocked attempts.

**Accessibility:** axe-core 4.14.1 (WCAG 2.0/2.1/2.2 A/AA plus best practice) runs on 12 routes
and states.

**Test-only components:** the EIP-6963 test wallets and the storage write used for insolvency
exist only in the harness. A check confirms the production bundle contains neither.

The harness writes a JSON report and the screenshots in [screenshots/](screenshots/) to
`KC_E2E_OUT`, which defaults to a temporary directory.

## Presentation rule

The application's own copy uses no em dashes or semicolons. Two checks enforce this on
rendered text, not on source code:
- UI tests render representative routes, states and every transaction state
- the browser harness checks the real rendered text of all 12 accessibility states.

Text supplied from outside is not enforced: wallet names, campaign names and descriptions that
users enter, and wallet or browser dialogs. The test data contains none of this punctuation.

## Static analysis

[Slither](https://github.com/crytic/slither) 0.11.4 was run on the Hardhat build in a
disposable environment outside the repository. It ran 100 detectors and reported 7 results: no
high-impact findings and no confirmed defects. Each result was classified (for example, the
documented balance-delta pattern in `contribute`, and timestamp use by design), with no
detector suppressions. **This is not an independent security audit.**

## Repository policy scan

```
node scripts/check-repo-policy.mjs          # tracked files
node scripts/check-repo-policy.mjs --dir D  # any directory, e.g. an export
```

The scan fails on these paths:
- every `.env` variant and `.envrc`
- key, keyring and wallet/keystore files
- local deployment manifests
- `node_modules`, generated build, ABI or coverage output
- logs, sync-conflict copies, OS metadata, assistant configuration
- symbolic links, which are reported and never followed.

It fails on this content:
- PEM/PGP private keys
- 32-byte hex literals shaped like private keys
- Hardhat account arrays and the well-known development mnemonic
- mnemonic, credential and token patterns
- macOS, Linux and Windows home paths
- email addresses
- PNG text or metadata chunks.

Three exclusions exist. Each is limited to one file, one rule and one line pattern, and the
scanner source states the reason. Reports never print matched values. `npm run test:policy`
runs 12 regression tests with synthetic, runtime-assembled values.

**Limits.**
- It is a pattern-based guard rail: it does not decode obfuscated content, does not scan Git
  history, and cannot recognise secrets with no known shape.
- An independent secret scanner remains the release gate.
- The absence of external requests is checked at runtime by the browser harness, not by this
  scan.

## Continuous integration

`.github/workflows/ci.yml` defines four jobs:

| Job | What it runs |
|---|---|
| policy | Policy-scanner regression tests, then the repository policy scan |
| test | Exact toolchain check, `npm ci --ignore-scripts`, compile, contract tests, frontend coverage, integration, build |
| browser | The browser harness |
| audit | `npm audit`, failing on critical advisories |

**Controls:**
- `permissions: contents: read`
- no secrets
- `persist-credentials: false`
- job timeouts
- actions pinned to full commit SHAs.

The workflow has been parsed and every job's commands have been run locally. **It has not yet
been executed on hosted GitHub Actions runners.**

## Toolchain

Node **22.23.5** and npm **10.9.9**, pinned in `.nvmrc`, `engines` and `packageManager`.
Dependencies are installed from `package-lock.json` with `npm ci`.
