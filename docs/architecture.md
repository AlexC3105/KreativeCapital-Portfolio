# Architecture

KreativeCapital is an **educational, unaudited** crowdfunding application for a **local
Ethereum development chain**. It is not intended for real funds or public networks.

## Overview

```
┌──────────────────────────── Browser (127.0.0.1) ────────────────────────────┐
│  React 18 + Vite 6 single-page app            Injected wallet (EIP-6963 /   │
│  ─ pages: Campaigns · Campaign · Create ·      EIP-1193), chosen by the user │
│    Get KT · My account · Transparency          through an accessible picker  │
│  ─ lib: units · manifest · verify ·                                          │
│    writeContext · tx · actions · api · wallet                                │
└───────────┬──────────────────────────────────────────┬───────────────────────┘
            │ GET /kc-deployment.json (dev/preview      │ JSON-RPC reads and
            │ server middleware; generated at deploy)   │ receipt polling
            ▼                                           ▼
   contracts/deployments/<network>.json      Hardhat node 127.0.0.1:8545 (chain id 31337)
   (never committed)                          ├─ KreativeToken  (ERC-20 "KT", fixed supply)
                                              └─ CampaignManager (registry + escrow + claims)
```

Every service the project starts binds explicitly to `127.0.0.1`: the node
(`hardhat node --hostname 127.0.0.1`), the Vite dev and preview servers, and the nodes started
by the integration and browser tests. The deploy script and the development time helper refuse
any RPC URL that is not strictly `http://127.0.0.1:<port>` or `http://localhost:<port>`. The
app makes no analytics, telemetry, CDN or font requests. Fonts are bundled locally (Cinzel, OFL-1.1).

## Smart contracts (`contracts/contracts/`)

Solidity 0.8.24 (optimizer off, EVM `paris`), OpenZeppelin Contracts 4.9.6, Hardhat 2.

### KreativeToken (`KreativeToken.sol`)

- Fixed supply of **1,000,000 KT** (18 decimals), all minted at deployment to the contract's
  own **sale reserve**. There is no mint or burn function.
- `buyTokens()` sells KT at exactly **100 KT base units per wei**, so 1 local ETH buys
  100 KT. Requests larger than the reserve revert. There is no partial fill.
- The reserve and the sale proceeds are **recorded counters** (`saleReserve`,
  `totalProceeds`, `proceedsWithdrawn`). Tokens or ETH sent to the contract outside these
  paths are reported (`unsolicitedTokenBalance`, `unsolicitedEthBalance`) and stay locked.
- `withdrawProceeds()` (owner only) sends exactly the recorded, unwithdrawn proceeds.
- `Ownable2Step` ownership. `renounceOwnership` is disabled so proceeds cannot be stranded.

### CampaignManager (`CampaignManager.sol`)

One contract holds every campaign. Campaign ids start at 1 and are never reused.

| Function | Who | Effect |
|---|---|---|
| `createCampaign(goal, duration, name, description)` | anyone | New campaign. Caller is the creator. Goal 0 < goal ≤ total supply. Duration 60 s – 365 days. Name 1–64 bytes. Description ≤ 500 bytes (UTF-8). |
| `contribute(id, amount)` | anyone, while `block.timestamp < deadline` | Pulls exactly `amount` KT (prior approval required). Records it only if exactly that amount arrived. |
| `finalize(id)` | anyone, once, at or after the deadline | Accounting only, with no token transfers: Successful if total ≥ goal, otherwise Failed. |
| `claimCreatorPayout(id)` | creator of a successful campaign, once | Pays the creator entitlement. |
| `claimRefund(id)` | each contributor to a failed campaign, once | Pays back exactly the recorded contribution. |
| `claimPlatformFees()` | current owner | Pays all earned, unclaimed fees. |

**Lifecycle:** `Active → Successful | Failed`. The read-only `phase(id)` adds the time-derived
"awaiting finalization" phase for display: Open → Awaiting finalization → Successful / Failed.

**Settlement is pull-based.** Each payout goes only to the entitled caller. No function sends
tokens to third parties, and nothing pushes funds automatically.

**Owner powers are deliberately narrow.** The owner can claim earned platform fees and
withdraw recorded KT sale proceeds, and nothing else. There is no function to withdraw escrow,
change an outcome, deadline, goal or creator, pause, freeze, sweep, mint or upgrade. An ABI
surface test enumerates every state-changing selector to enforce this.

### Liability ledger and solvency guard

`totalOutstanding` tracks every unpaid obligation: active escrow, unpaid creator entitlements,
unrefunded contributions to failed campaigns, and unclaimed platform fees. The contract holds
the invariant `token.balanceOf(manager) ≥ totalOutstanding`.

If the balance ever falls below the ledger (this is impossible through the public interface, and the tests
create it with a test-only storage write), `contribute` and every outgoing claim revert with
`Insolvent(balance, liabilities)`. Creation, finalization and all read-only views keep working,
and claims resume automatically once the backing is restored. No administrator can override
the rule. The views `tokenBalance`, `isSolvent`, `excessBalance` and `shortfall` expose the
state. KT sent directly to the manager is never credited to anyone and remains locked as
excess.

## Deployment manifest

`npm run deploy:local` deploys both contracts with a Hardhat-provided development account and
writes `contracts/deployments/<network>.json` (schema version 2). The manifest records the chain
id, the loopback RPC URL, the genesis block hash, each contract's address, deployment block
number and hash, and runtime code hash. It is generated at deploy time and **ignored by git**.
The Vite dev and preview servers serve it at `/kc-deployment.json`. It is never bundled.

## Frontend (`frontend/src/`)

| Layer | File(s) | Responsibility |
|---|---|---|
| Units | `lib/units.js` | Exact `bigint` base units, decimal parsing and formatting with no floating point, UTF-8 byte lengths, duration bounds and the floor fee split |
| Manifest | `lib/manifest.js` | Loads and validates the manifest: structure, loopback-only RPC, checksummed addresses |
| Verification | `lib/verify.js` | Chain id, chain instance (genesis hash), deployment block hashes, runtime code hashes, deployed bytecode against the compiled artifact (immutables masked), contract wiring, and the wallet chain check, including a different chain that reuses id 31337 |
| Write context | `lib/writeContext.js` | Before **every** write: re-verify the deployment, confirm the wallet's current account equals the verified account the action was started for, verify the chain, then create a signer. `recheck()` repeats the account, chain and context checks immediately before submission |
| Transactions | `lib/tx.js` | Evidence-based states: validating → blocked / awaiting wallet → rejected / submitted → pending → verifying → confirmed / reverted / unknown |
| Actions | `lib/actions.js` | Buy, exact approve/revoke, create, contribute, finalize, payout, refund, fees, proceeds |
| Reads | `lib/api.js` | Bounded newest-first pagination, phases from chain time, platform and account aggregates |
| Wallet | `lib/wallet.js` | EIP-6963 discovery, with a `window.ethereum` fallback |
| State | `state/AppProvider.jsx` | Deployment loading and periodic re-verification (stale detection), wallet context epochs (account and network listeners), refresh on new blocks |
| Section guards | `state/txStore.js`, `state/AppContext.js` (`useTx`) | Application-level, per section: duplicate-submission guard and a pause after an *unknown* outcome until it is resolved. They survive navigation and are cleared by a full reload. |
| UI | `pages/*`, `components/*` | Six routes, status banners, `aria-live` transaction status, and a WebGL hero with an error boundary and static fallback |
| Examples | `lib/examples.js`, `components/ExampleCampaigns.jsx` | Static, labelled homepage example cards (presentation only): no chain access, no actions, never imported by the API or actions |

### Write path

1. Validate the input locally with exact integer arithmetic.
2. **Capture the user's intent:** the verified account shown in the UI and the current wallet
   context *epoch*. Every wallet event (account change, network change, connect, disconnect)
   starts a new epoch. An account change disables writes at once. A network change does so
   after one wallet call to read the account. A write started in that brief gap is still refused
   by the checks in step 3. Writes stay disabled until the new context is verified and shown.
   Verification results from an older epoch are discarded.
3. Re-verify the deployment and the wallet's account and chain (`writeContext`). The action is
   refused if the account differs from the captured one or the epoch has changed. It is never
   carried over to another account.
4. Simulate the call against the read RPC. Known custom errors are decoded into plain
   messages, and the wallet is not prompted if the simulation fails.
5. Build the request with `from` = the verified account, `to` = the expected contract and
   `chainId` = 31337, and check those fields. Then `recheck()` the account, chain and epoch, and
   submit with `sendUncheckedTransaction`, keeping only the hash.
6. Poll for the receipt through the verified read RPC, with a time limit. A transaction that
   never appears ends as **unknown**.
7. Before trusting the receipt, compare the mined transaction with the request: sender,
   destination, data, value, chain, and a block after submission. A mismatch, such as a
   wallet returning an unrelated or replayed hash, ends as **unknown**.
8. Report **confirmed** only when receipt status 1, the expected event and a block-tagged state
   check all agree.

**What is enforced where.**
- The app enforces steps 2–8.
- What the wallet finally signs is the wallet's behaviour. A standards-compliant wallet refuses
  to sign a request whose pinned `chainId` differs from its network, but the app cannot
  guarantee that. If anything unexpected is mined, step 7 keeps it out of the *confirmed*
  state.

The account that submitted a transaction keeps the attribution even if the wallet switches
account or network while it is pending.

**Unknown outcomes.**
- An *unknown* result is never shown as success or failure, and nothing retries automatically.
- That section of the page stays paused, with the hash, account, request and submission block
  kept in the record, until one of two things happens:
  - the user runs **Check status**, and the outcome is known. This read-only check first
    compares the chain's genesis hash with the manifest, which detects a restarted node but
    does not by itself prove that the deployment is unchanged. It then evaluates a late receipt
    with exactly the original checks (request match, receipt status, expected event and
    contract state), all bound to the original contract addresses, so a confirmation is always
    about the original transaction and deployment. Only
    *confirmed and verified* or *reverted* resolves it. *Not found* allows another check. A
    mismatch or failed verification keeps the pause and offers no further check.
  - the user confirms they have checked their wallet, which is explicitly not proof of
    success.
- There is no background reconciliation, and nothing is retried.

**Lifetime of these guards.**
- The pending flag, the unknown-outcome pause and the latest status of each page section are
  kept in an application-level store (`state/txStore.js`). Navigating between pages and
  remounting does not clear them, and an operation that finishes after its page was left still
  updates its section.
- They live in memory for the open tab only. A full browser reload clears them (the chain is
  unaffected).
- Each pause belongs to a page section (for example Get KT, or one campaign's contribution
  panel), not to the current wallet account, so switching accounts does not lift it.

### Safety refusals

Financial writes are disabled, with a visible banner, when:
- the manifest is missing or invalid, or the chain is unreachable
- the chain was restarted (stale manifest)
- the deployed code does not match the compiled artifacts
- the wallet is on another chain, or on a different chain instance that uses the same id
- the wallet's account or network changed since the action was started, or the new context is
  still being verified.

The app never asks for a seed phrase or private key and never adds or switches to a public
network.

## Repository layout

```
contracts/          Hardhat workspace: contracts, deploy script, dev scripts, tests
frontend/           Vite workspace: app source, unit/UI + integration tests, browser harness
scripts/            repository policy scanner and its regression tests
docs/               public documentation and screenshots
.github/workflows/  CI definition (prepared; see testing.md)
```
