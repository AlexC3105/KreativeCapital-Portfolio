# Manual wallet-extension validation

**Status: deferred by the project owner and not executed.** Automated tests use test-only EIP-1193/EIP-6963 wallets, so
compatibility with any real wallet extension (for example MetaMask) **has not been verified**.
This is the owner's acceptance procedure for that item. It runs on its own local chain and
ports, so it does not touch any other local session.

## Safety rules

- Use a **new, disposable browser profile**. Never use your everyday profile, personal wallet or
  real accounts. Install the wallet extension only in that profile.
- Use only the development accounts printed by the local node. They are publicly known test
  accounts: anyone can control them. **Never send real funds to them**, and never import them
  anywhere except the disposable profile.
- Never paste keys or seed phrases into the app, issues, notes or screenshots. The app never
  asks for them.
- No step uses a public network or real assets. Wrong-network testing uses a second, isolated
  local chain (Terminal D). Do not select public networks in the test profile.

## 1. Setup (five terminals, from a disposable clone)

```bash
git clone <repository-url> kc-wallet-test && cd kc-wallet-test
npm ci --ignore-scripts && npm run compile

# Terminal A: local chain on a spare loopback port
cd contracts && npx hardhat node --hostname 127.0.0.1 --port 8555

# Terminal B: deploy to exactly that chain (writes contracts/deployments/kcManual.json)
cd contracts && npx hardhat run scripts/deploy.js --network kcManual

# Terminal C: frontend on a separate port, reading the kcManual manifest
cd frontend && KC_DEPLOYMENT_NETWORK=kcManual npx vite --host 127.0.0.1 --port 5180 --strictPort

# Terminal D (for step 9 only): a second, unrelated local chain that reuses id 31337
cd contracts && npx hardhat node --hostname 127.0.0.1 --port 8556

# Terminal E (when told): advance the kcManual chain's clock
npm run dev:advance-time -- 600 http://127.0.0.1:8555
```

Open `http://127.0.0.1:5180` in the disposable profile. **Transparency** must report
*Deployment verification: verified* with the RPC `http://127.0.0.1:8555`.

## 2. Wallet configuration

1. Add a custom network: RPC URL `http://127.0.0.1:8555`, chain id `31337`, symbol `ETH`.
   Wallets often have a built-in "Localhost 8545" network. Do not use it, because it points
   at a different port.
2. From the accounts printed in Terminal A, import three accounts into this profile only:
   - **#0, owner** (it deployed the contracts)
   - **#1, creator**
   - **#2, contributor**.

## 3. Checklist

Record the following first:
- the wallet name and version
- the browser name and version
- the date
- the tester.

Fill in **Actual** with Pass or Fail and the exact on-screen message.

| # | Step | Expected result | Actual |
|---|---|---|---|
| 1 | Click **Connect wallet**. If two wallet extensions are installed, use the picker. | Picker lists the wallets. After choosing, the header shows the account with a green dot. | |
| 2 | Disconnect, then connect again and reject the connection request in the wallet. | "The connection request was rejected." Nothing connected. | |
| 3 | As **#1**: **Get KT** with 10 ETH. As **#2**: **Get KT** with 5 ETH. | Each status *Confirmed and verified*. Balances +1,000 KT and +500 KT. | |
| 4 | As **#1**: create a campaign (goal 100 KT, duration 10 minutes) and a second one (goal 1,000 KT, duration 10 minutes). | Both *Confirmed and verified*. Ids #1 and #2. | |
| 5 | As **#2**, within the 10 minutes: on #1, **Approve exactly 150 KT**, then **Contribute**. On #2, approve and contribute 30 KT. | The wallet prompt shows the exact amounts. Each status *Confirmed and verified*. | |
| 6 | Terminal E: advance 600 s (`npm run dev:advance-time -- 600 http://127.0.0.1:8555`). As any account: **Finalize** #1 and #2. | #1 *Successful* (fee 1.5 KT). #2 *Failed*. | |
| 7 | As **#1**: **Claim creator payout** on #1. As **#2**: **My account**, then **Claim refund** on #2. | Payout 148.5 KT. Refund 30 KT. The claims are not offered again. | |
| 8 | As **#0**: **My account**, then **Claim platform fees** and **Withdraw proceeds**. As #1: the owner controls state that the account is not the owner. | 1.5 KT fees. Recorded ETH proceeds withdrawn. Non-owner cannot claim. | |
| 9 | Wrong network: switch the wallet to the Terminal D network (`http://127.0.0.1:8556`, chain id 31337), an isolated second local chain. Send nothing. | Banner "different chain that also uses id 31337". Writes disabled. Switching back to 8555 restores writes after verification. | |
| 10 | Back on 8555: approve 5 KT on a campaign page, then **My account**, then **Revoke**. | Allowance 0 KT after *Confirmed and verified*. | |
| 11 | Start an action, then reject it in the wallet. | *Rejected in wallet*. Nothing reported as success. | |
| 12 | Switch accounts in the wallet, then immediately click an action button. | Buttons are disabled while the new account is verified (*Verifying the wallet's account and network…*). A click before the wallet notifies the app is refused: "account or network changed". The action is never sent from the new account. | |
| 13 | Start an action as #1, switch the wallet to #2 while the wallet prompt is open, then approve. | Wallet-dependent: the wallet refuses, or signs as #1 (the request pins `from` = #1 and chain 31337). If anything is mined from another account, the app shows *Unknown*, never success. The status shows "From" #1 only. | |
| 14 | Stop Terminal A and start it again (same command), without redeploying. | *Stale deployment manifest* banner, and a second banner about a different chain (expected after a restart). Data and writes unavailable. | |
| 15 | Redeploy (Terminal B), reset the wallet's activity/nonce data for each account, reload. | Banners clear and a purchase is *Confirmed and verified* again. | |

## 4. After the test

- Remove the disposable browser profile.
- Stop Terminals A–E.
- Delete the disposable clone.
- Record the completed table, without keys, seed phrases or addresses that hold anything of
  value.
- Until this is recorded, the project makes **no claim** of real-wallet compatibility.
