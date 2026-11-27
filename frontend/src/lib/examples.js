// Illustrative example campaigns for the homepage (presentation only).
// Static, locally defined data: never read from or written to the chain, never passed to the
// API, actions, account views or platform statistics, and never given an on-chain campaign id
// or contract address. Names echo the original 2024 capstone mock cards.
const KT = (n) => BigInt(n) * 10n ** 18n;

export const EXAMPLE_CAMPAIGNS = Object.freeze([
  Object.freeze({
    key: "example-active",
    name: "CryptoBridge Literacy Workshops",
    description: "Free evening workshops introducing community members to wallets, tokens and how on-chain escrow works.",
    goal: KT(1_000),
    totalContributed: KT(750),
    phase: 0, // Open
    status: "Accepting contributions · 10 days left",
  }),
  Object.freeze({
    key: "example-successful",
    name: "Smart Contract Solutions Lab",
    description: "A student lab that publishes open, well-tested smart-contract templates for small nonprofits.",
    goal: KT(5_000),
    totalContributed: KT(5_600),
    phase: 2, // Successful
    status: "Goal met · 1% platform fee (56 KT) · creator entitlement 5,544 KT",
  }),
  Object.freeze({
    key: "example-failed",
    name: "Blockchain Ventures Hackathon",
    description: "A weekend hackathon for first-time builders that did not reach its goal before the deadline.",
    goal: KT(2_000),
    totalContributed: KT(1_300),
    phase: 3, // Failed
    status: "Goal missed · no fee · every contributor may reclaim 100% of their contribution",
  }),
]);

export const EXAMPLE_DISCLAIMER =
  "Illustrative campaigns for demonstration purposes. These are not on-chain campaigns and do not involve real transactions.";
