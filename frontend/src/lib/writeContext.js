// Write-time revalidation shared by the React provider and the local-chain integration tests.
// When the user starts an action, the caller passes the account the UI was verified for
// (`expectedAccount`) and an `isCurrent` check of its own wallet context. Before a signer is
// created: the deployment must verify on-chain, the wallet's current account must equal
// `expectedAccount`, and the wallet must be on the same local chain instance.
// `recheck()` repeats the account, chain and context checks immediately before submission.
// These are application-enforced checks; what the wallet finally signs remains the wallet's
// responsibility (the request also pins chainId 31337, see actions.js).
import { getAddress } from "ethers";
import { EXPECTED_CHAIN_ID } from "./manifest.js";
import { verifyDeployment, verifyWalletChain } from "./verify.js";

const CHANGED = {
  ok: false,
  code: "account-changed",
  reason: "Your wallet account or network changed, so this action was not submitted. Review it for the current account and try again.",
};

async function currentAccount(eip1193) {
  const accounts = await eip1193.request({ method: "eth_accounts" });
  return accounts?.[0] ? getAddress(accounts[0]) : null;
}

/**
 * @returns {Promise<{ok: true, account: string, chainId: bigint, signer: object, recheck: () => Promise<object>} | {ok: false, reason: string, code: string}>}
 */
export async function buildWriteContext({
  provider,
  manifest,
  artifacts,
  eip1193,
  expectedAccount,
  isCurrent = () => true,
  createBrowserProvider,
  verifyDeploymentFn = verifyDeployment,
  verifyWalletFn = verifyWalletChain,
}) {
  if (!eip1193) return { ok: false, code: "no-wallet", reason: "Connect a wallet first." };
  if (!expectedAccount) return { ok: false, code: "context-unverified", reason: "Your wallet's account has not been verified yet." };
  const expected = getAddress(expectedAccount);
  const deployment = await verifyDeploymentFn(provider, manifest, artifacts);
  if (!deployment.ok) {
    return { ok: false, code: deployment.stale ? "stale" : "unverified", reason: "The local deployment is not verified (stale, changed or unavailable). Writes are disabled." };
  }
  const account = await currentAccount(eip1193);
  if (!account) return { ok: false, code: "no-account", reason: "The wallet has no connected account." };
  if (account !== expected || !isCurrent()) return CHANGED;
  const chain = await verifyWalletFn(eip1193, manifest);
  if (!chain.ok) return { ok: false, code: chain.code, reason: chain.reason };
  if (!isCurrent()) return CHANGED;
  const signer = await createBrowserProvider(eip1193).getSigner(account);

  const recheck = async () => {
    if (!isCurrent()) return CHANGED;
    if ((await currentAccount(eip1193)) !== account) return CHANGED;
    const again = await verifyWalletFn(eip1193, manifest);
    if (!again.ok) return { ok: false, code: again.code, reason: again.reason };
    if (!isCurrent()) return CHANGED;
    return { ok: true };
  };
  return { ok: true, account, chainId: BigInt(EXPECTED_CHAIN_ID), signer, recheck };
}
