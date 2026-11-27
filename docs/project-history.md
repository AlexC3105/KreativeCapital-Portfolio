# Project history

## 2024: bootcamp capstone

KreativeCapital began as a solo final project for the **UM FinTech Bootcamp** (August–September
2024). The original 2024 code and its full Git history are kept in the author's private
development repository. This public copy starts with a fresh history and contains only the
modernized project. Nothing in it depends on the historical material.

The 2024 version included:
- an ERC-20 token, KreativeToken (KT), with a fixed supply and an ETH purchase function
- an ETH crowdfunding campaign contract with a deadline, goal and refunds
- a factory contract for KT-denominated campaigns
- a Create React App frontend (campaign creation, dashboard, account page, Three.js hero)
- a slide presentation.

### What the 2024 version did not do

The original README and slides described some features that the 2024 code did not implement.
These are recorded here for transparency:
- browser-wallet (MetaMask) integration, which the slides themselves listed as a next step
- a Node.js/Express backend
- refunds for failed KT campaigns, since the token factory had no refund path
- a fee charged only on successful campaigns, since the factory charged it on every
  contribution
- independent audits.

The 2024 build also had two separate funding models, a placeholder contribute button on the
home page and an admin panel that called a non-existent function.

## 2026: modernization

In 2026 the project was rebuilt as a coherent, tested application. The work was **AI-assisted**
(Claude Code), under the author's direction and review at each stage. The detailed change
history and stage records are kept in the private development repository. The author made
each architectural decision and gave each stage acceptance.

The modernization proceeded in stages:

| Stage | Outcome |
|---|---|
| Baseline | The 2024 build was reproduced as found. Unsupported claims and defects were catalogued. Personal data and generated files were identified. |
| Environment | Reproducible installs, lockfiles, a local-only Hardhat setup, generated output untracked |
| Architecture | Financial rules written down before any code: a single KT funding model, a 1% fee on success only, full refunds on failure, pull claims, a liability ledger and a solvency guard, narrow owner powers, plus a rule-to-test traceability matrix |
| Contracts | `KreativeToken` and `CampaignManager` rewritten from the specification. 100+ tests, including a randomized reference model |
| Frontend | React 18 + Vite rewrite on ethers v6: exact units, deployment verification, evidence-based transaction states, wallet discovery, accessible UI with the original visual identity |
| Validation | Local-chain integration tests, a headless browser harness with outbound requests blocked, axe-core accessibility checks, Slither static analysis, coverage measurement and a CI definition |
| Publication preparation | Public documentation, demo screenshots, a public-safe source review and an allowlist-based export |
| Independent review | An AI-assisted review by fresh sessions (not a professional audit). Its corrections were applied: wallet account/network-change handling, chain-pinned requests, uncertain-transaction handling, stricter local-network enforcement, stronger tests and repository scanning, and original replacement artwork. |

### What changed, in substance

| Area | 2024 | 2026 |
|---|---|---|
| Funding model | ETH campaigns in the UI, KT campaigns in a separate factory | One KT-denominated model in a single `CampaignManager` |
| Fee | 1% on every contribution | 1% (rounded down) only when a campaign succeeds |
| Failed campaigns | No refund path for KT campaigns | Every contributor reclaims exactly their contribution |
| Payouts | Automatic transfer when the goal is reached | Permissionless finalization after the deadline, then pull claims |
| Owner powers | Owner-controlled withdrawals | Earned fees and recorded sale proceeds only, renounce disabled, two-step transfer |
| Wallet | Unlocked local-node accounts | User's wallet via EIP-6963, with verification before every write |
| Tests | Partly broken scripts | Contract, unit/UI, integration and browser suites |

## Current status and limitations

- Educational and unaudited. Local development chain only.
- Not tested with a real wallet extension yet (see
  [manual-wallet-validation.md](manual-wallet-validation.md)).
- The CI workflow is defined but has not yet run on hosted runners.
- Dependency advisories are not fixed. The independent review supports bounded acceptance within
  the local educational scope. Final owner approval is pending (see [security.md](security.md)).
- The contracts support only the canonical KreativeToken (see
  [financial-model.md](financial-model.md)).
