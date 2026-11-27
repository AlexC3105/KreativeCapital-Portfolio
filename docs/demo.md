# Demo guide

Three scenarios on a **local development chain**:
- **A**, a successful campaign
- **B**, a failed campaign with full refunds
- **C**, the integrity safeguards.

Everything runs on `127.0.0.1`. KT and local ETH have no value.

There are two ways to run the demo:

1. **Automated (recommended, no wallet needed).** The browser harness performs scenarios A, B
   and C in headless Chrome with test-only wallets and saves screenshots.
2. **Manual, in your own browser.** This needs a wallet extension installed in a **disposable
   browser profile**. Follow [manual-wallet-validation.md](manual-wallet-validation.md). Real
   wallet-extension compatibility has not been verified yet.

## Setup

Requires Node 22.23.5 and npm 10.9.9 (see `.nvmrc`).

```bash
npm ci --ignore-scripts
npm run compile
```

### Automated run

```bash
KC_E2E_OUT=./demo-output npm run e2e:browser
```

The harness starts its own chain (`127.0.0.1:8547`) and production preview
(`127.0.0.1:4174`), runs 36 checks, and writes `browser-check.json` plus `demo-*.png`
screenshots to `KC_E2E_OUT`. The output directory is not tracked. Delete it when you are done.
Chrome or Chromium must be installed. Set `CHROME_PATH` if it is not found automatically.

### Manual run (three terminals)

```bash
npm run node          # 1: local chain bound to 127.0.0.1:8545 (prints disposable development accounts)
npm run deploy:local  # 2: deploys both contracts and writes the local manifest
npm run dev           # 3: app at http://127.0.0.1:5173
```

Open `http://127.0.0.1:5173`. The **Transparency** page should report
*Deployment verification: verified*.

**Development-only time control.** Campaigns last at least 60 seconds. To reach a deadline
without waiting, advance the local chain's clock:

```bash
npm run dev:advance-time -- 120        # seconds; refuses non-loopback URLs and chains other than 31337
```

This calls the Hardhat-only `evm_increaseTime` and `evm_mine` methods. It is a
development tool and does not exist on real networks.

## Scenario A: successful campaign

| Step | Account | Action | Expected result |
|---|---|---|---|
| 1 | Creator | **Get KT**: pay 10 ETH | Buys exactly 1,000 KT. Status *Confirmed and verified* |
| 2 | Creator | **Create campaign**: goal 100 KT, duration 2 minutes | Campaign #1 created. Id taken from the verified event |
| 3 | Backer | **Get KT**, then on campaign #1: **Approve exactly 150 KT** → **Contribute** | Recorded contribution 150 KT (150% of goal). Approval for the exact amount only |
| 4 | n/a | Wait or run `npm run dev:advance-time -- 120` | Phase becomes *Awaiting finalization* |
| 5 | Anyone | **Finalize** | Outcome *Successful*. Fee 1.5 KT, creator entitlement 148.5 KT |
| 6 | Creator | **Claim creator payout** | Receives 148.5 KT. Claim cannot be repeated |
| 7 | Owner (deployer account) | **My account** → **Claim platform fees** | Receives 1.5 KT. The controls are hidden for other accounts |
| 8 | n/a | **Transparency** | Reconciliation: recorded liabilities 0 KT, actual balance 0 KT, *Solvent*. Tokens sold and recorded sale proceeds match the purchases (100 KT per ETH) |

Screenshots:
- [create](screenshots/demo-02-create-confirmed.png)
- [contribution](screenshots/demo-03-contribution-confirmed.png)
- [payout](screenshots/demo-04-successful-payout.png)
- [owner fees](screenshots/demo-05-owner-fees.png)
- [campaign list](screenshots/demo-01-home-campaigns.png).

## Scenario B: failed campaign, full refund

| Step | Account | Action | Expected result |
|---|---|---|---|
| 1 | Creator | Create a campaign with a goal it will not reach (e.g. 1,000 KT, 2 minutes) | Campaign created |
| 2 | Backer | Approve exactly and contribute 30 KT | Recorded 30 KT |
| 3 | n/a | Advance past the deadline | *Awaiting finalization* |
| 4 | Anyone | **Finalize** | Outcome *Failed*. No fee and no creator payout |
| 5 | Backer | **My account** → **Claim refund** | Receives exactly 30 KT. The entry shows *refunded* |

Screenshot: [refund](screenshots/demo-07-failed-refund.png).

## Scenario C: integrity safeguards

| Check | How to trigger | Expected result |
|---|---|---|
| Repeated claims | After a payout or refund, revisit the campaign or **My account** | The claim action is gone (*payout has been claimed* / *refunded*). The contract rejects a second claim with `AlreadyClaimed` (contract and integration tests). |
| Unauthorized claims | Connect a non-owner, non-creator account | Owner controls state that the account is not the owner. Payout and fee claims by other accounts are rejected on chain (`NotCreator`, `Ownable: caller is not the owner`). The interface cannot bypass this. |
| Deployment verification | Open **Transparency** | Ten checks pass: chain id, genesis, deployment blocks, runtime code hashes, bytecode against the compiled artifacts, wiring, symbol ([screenshot](screenshots/demo-06-transparency.png)) |
| Solvency monitoring | **Transparency** | Balance, recorded liabilities, status, excess and shortfall are shown from contract views |
| Wrong network | Switch the wallet to another chain | *Wrong network* banner. Financial writes disabled ([screenshot](screenshots/demo-09-wrong-network.png)) |
| Stale deployment | Restart `npm run node` without redeploying | *Stale deployment manifest* banner, plus a second banner about a different chain instance (the wallet is compared with the stale manifest). Data and writes unavailable until `npm run deploy:local` ([screenshot](screenshots/demo-10-stale-deployment.png)) |
| Wallet rejection | Reject a request in the wallet | Status *Rejected in wallet*. Nothing reported as success |
| Insolvency (**test-only**) | Automated harness only | *Contributions and claims are unavailable* notice. Finalization and monitoring still work. Full recovery once backing is restored ([screenshot](screenshots/demo-08-insolvency-test-only.png)) |

Insolvency **cannot be produced through the application or the contracts' public interface**.
The harness creates it with the Hardhat-only `hardhat_setStorageAt` method to show how the
guard behaves. No script for it ships with the app, and the production bundle contains no
test-only code, which the harness checks.

## Example campaigns on the homepage

The homepage shows three illustrative **Example Campaigns** (active, successful, failed with
refund eligibility). They help visitors understand the lifecycle without a wallet or a running
chain.
- Each card is labelled *Example*, and a section notice states that they are not on-chain and
  involve no real transactions.
- They are static presentation data. They have no actions or links, and are never added to live
  campaign counts, balances or accounting.
- They stay visible when the chain is unavailable or no campaigns exist.
- Real campaigns are listed separately under **Live Campaigns**, with on-chain ids and links.

See the [homepage screenshot](screenshots/demo-01-home-campaigns.png).

## Other screenshots

- [Home with the WebGL hero](screenshots/demo-00-home-webgl.png).
- [Mobile layout with the menu open](screenshots/demo-11-mobile.png).

All screenshots come from automated harness runs. They show only disposable Hardhat
development account addresses, loopback URLs and test data.

## After a node restart

A restarted Hardhat node is a new chain. Run `npm run deploy:local` again. If you use a wallet
extension, reset its activity/nonce data for the development account, because wallets cache
nonces from the previous chain.
