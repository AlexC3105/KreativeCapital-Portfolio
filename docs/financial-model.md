# Financial model

This is the specification the contracts implement and the tests check. All amounts are KT base
units (18 decimals) and all arithmetic is exact integer arithmetic, both on chain and in the
frontend (`bigint`, with no floating point).

> KT is an educational token on a local development chain. It has **no monetary value, no
> redemption rights and no backing**. Local "ETH" is development-chain ETH only.

## Token issuance and sale

| Parameter | Value |
|---|---|
| Total supply | 1,000,000 KT (10²⁴ base units), fixed. No mint or burn |
| Initial allocation | 100% to the token contract's recorded sale reserve |
| Price | 100 KT base units per wei, so 1 ETH buys 100 KT |
| Partial fills | None. A purchase larger than the remaining reserve reverts (`InsufficientReserve`). |
| Zero purchase | Reverts (`ZeroPurchase`) |
| Proceeds | Recorded per purchase. The owner may withdraw exactly `totalProceeds − proceedsWithdrawn`. |

ETH sale proceeds are held in `KreativeToken`. Campaign escrow is held in KT by
`CampaignManager`. Neither contract can move the other's funds.

## Campaign rules

| Rule | Specification |
|---|---|
| Goal | 0 < goal ≤ total supply |
| Duration | 60 seconds to 365 days, inclusive. `deadline = createdAt + duration` |
| Contribution window | Accepted while `block.timestamp < deadline`. Rejected at and after the deadline |
| Over-funding | Allowed until the deadline. Reaching the goal early does not close the campaign. |
| Self-funding | Creators may contribute to their own campaigns under the same rules, so a funding total does not prove independent demand. |
| Exact receipt | A contribution is recorded only if the manager's balance grew by exactly the amount. It reverts with `ReceivedAmountMismatch(expected, received)` otherwise. This guards incoming transfers only (see the canonical-token assumption below). |
| Finalization | Permissionless, exactly once, at or after the deadline. It moves no tokens. |
| Outcome | `total ≥ goal` → **Successful**. `total < goal` (including 0) → **Failed** |

## Lifecycle

```
                 createCampaign
                       │
                       ▼
             ┌───────────────────┐   contribute (t < deadline)
             │       Open        │◄──────────────┐
             │  (status Active)  │───────────────┘
             └─────────┬─────────┘
                       │ t ≥ deadline
                       ▼
             ┌───────────────────┐
             │     Awaiting      │   phase only (derived from chain time);
             │   finalization    │   status is still Active
             └─────────┬─────────┘
                       │ finalize (anyone, once; no token transfer)
          total ≥ goal │ total < goal
          ┌────────────┴─────────────┐
          ▼                          ▼
  ┌───────────────┐          ┌───────────────┐
  │  Successful   │          │    Failed     │
  └───┬───────┬───┘          └───────┬───────┘
      │       │                      │
      │       └─ fee → platform fees │
      ▼          (owner claims)      ▼
 claimCreatorPayout            claimRefund
 (creator, once)               (each contributor, once)
```

## Settlement

With **T** the campaign total at finalization:

| Outcome | Platform fee | Creator entitlement | Contributors |
|---|---|---|---|
| Successful | `fee = ⌊T × 100 / 10 000⌋` (1%, rounded down) | `T − fee` (receives the rounding remainder) | nothing to reclaim |
| Failed | 0 | 0 | each reclaims **exactly** their recorded total |

The fee is charged **only on successful campaigns**. Worked examples:

| T (KT) | Fee | Creator |
|---|---|---|
| 150 | 1.5 | 148.5 |
| 100 | 1 | 99 |
| 99 base units | 0 | 99 base units |
| 199 base units | 1 base unit | 198 base units |

Every payout is a **pull claim** made by the entitled account, once:
- the creator of a successful campaign calls `claimCreatorPayout`
- each contributor to a failed campaign calls `claimRefund`
- the current owner calls `claimPlatformFees` for all accrued fees, including fees accrued
  before an ownership transfer.

## Liability ledger

```
totalOutstanding = Σ active escrow
                 + Σ unpaid creator entitlements
                 + Σ unrefunded contributions to failed campaigns
                 + platformFeesOutstanding
```

| Event | Change in `totalOutstanding` |
|---|---|
| Contribution of `a` | `+a` |
| Finalization | unchanged (escrow is reclassified into entitlement + fee, or into refunds) |
| Payout, refund or fee claim of `a` | `−a` |

**Invariant:** `token.balanceOf(CampaignManager) ≥ totalOutstanding`.

- `excessBalance = max(0, balance − totalOutstanding)`: unsolicited KT, never credited to any
  campaign, fee or claimant, and locked (no sweep).
- `shortfall = max(0, totalOutstanding − balance)`.

## Logical isolation and shared physical escrow

Campaigns are isolated **logically, not physically**. Every campaign's KT sits in one
`CampaignManager` balance. Isolation comes from accounting:
- each campaign records its own total, per-contributor amounts, fee, creator entitlement and
  `outstanding` obligations
- every claim is limited to the claimant's own recorded entitlement in one campaign, so no
  campaign's claims can draw on another campaign's records.

The tradeoff is that the **physical balance is shared**. If the balance were ever short (for
example through a defect in the token or the manager), the shortfall would not belong to any
single campaign. In that situation, paying claims first-come-first-served would let early
claimants take other campaigns' backing. The solvency guard prevents this: it stops all
outgoing claims at once instead.

## Solvency guard

If `balance < totalOutstanding`:

| Operation | Behaviour |
|---|---|
| `contribute`, `claimCreatorPayout`, `claimRefund`, `claimPlatformFees` | Revert with `Insolvent(balance, liabilities)`, with no state changes |
| `createCampaign`, `finalize`, every view | keep working |
| Recovery | Automatic once the balance is restored. Entitlements are unchanged. |
| Override | None. No administrator can bypass the rule. |

**Availability tradeoff.** The guard puts fairness ahead of availability. While insolvent:
- **no one** can contribute or claim, including people whose own campaign would be fully
  covered on its own
- there is no partial or pro-rata payout and no administrator override
- funds stay locked until someone restores the balance by transferring KT to the manager.

This was chosen deliberately for an educational design. It keeps recorded entitlements intact
and avoids a race between claimants.

Ineligible callers still receive their specific error (for example `NotCreator`) while
insolvent. Insolvency cannot arise through the public interface with the canonical token. The
tests and the demo create it with a test-only storage write. One regression test (R1) also
shows it with an out-of-scope outgoing-fee mock token (see the canonical-token assumption
below).

## Canonical-token assumption

The project supports exactly one asset: the canonical **KreativeToken**. It is a plain
OpenZeppelin ERC-20 with a fixed supply and no transfer fees, hooks, rebasing or burning, so
every outgoing `transfer(amount)` lowers the manager's balance by exactly `amount`.

**Why a check before each transfer is sufficient.**
- Each claim checks `balance ≥ totalOutstanding` and then lowers both sides by the same
  amount, so a solvent manager stays solvent.
- Contributions are additionally guarded on the way in: a contribution is recorded only if the
  balance grew by exactly the amount.

**Out of scope:** fee-on-transfer, rebasing, hook-bearing or otherwise non-standard tokens.
With such a token, a single claim could pass the pre-transfer check and still create a
shortfall, because the token takes more than `amount` from the manager. Later claims would
then be stopped by the guard.
- This is demonstrated with a test-only outgoing-fee mock (`ReviewRegressions.test.js`, R1). It
  is recorded as a documented limitation, not a supported configuration.
- Supporting arbitrary tokens would require a balance check after each transfer, and that is
  not part of this project.

## What the owner can and cannot do

| Can | Cannot |
|---|---|
| Claim earned platform fees | Withdraw escrow or entitlements |
| Withdraw recorded KT sale proceeds | Change outcomes, deadlines, goals or creators |
| Transfer ownership in two steps (`Ownable2Step`) | Renounce ownership (disabled on both contracts) |
| | Mint, burn, pause, freeze, sweep or upgrade |

## Invariants checked by the randomized suite

A deterministic randomized test (20 seeds × 200 operations) runs mixed sequences of purchases,
creations, contributions, time jumps, finalizations, payout/refund/fee claims and unsolicited
transfers. It compares the contracts against an independent reference model after every step,
including the exact revert expected for invalid operations:
- `totalOutstanding` equals the model's ledger, and the balance equals ledger plus excess
- every campaign field (status, total, fee, entitlement, outstanding, paid flag) matches
- per campaign, paid out + outstanding + fee equals the total
- every contributor's recorded contribution and refund flag matches
- KT supply is conserved (sale reserve + all balances = total supply).

Ownership transfers and proceeds withdrawal are covered by dedicated unit tests.

See [testing.md](testing.md).
