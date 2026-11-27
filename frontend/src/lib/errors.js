// Translate wallet/RPC/contract errors into user-facing categories and messages.

const MESSAGES = {
  Insolvent:
    "Blocked by the contract's solvency rule: its KT balance is below its recorded liabilities. Contributions and claims resume automatically once backing is restored. No administrator can override this.",
  CampaignEnded: "This campaign no longer accepts contributions: its deadline has been reached.",
  CampaignNotEnded: "The campaign deadline has not been reached yet.",
  AlreadyFinalized: "This campaign has already been finalized.",
  NotFinalized: "The campaign must be finalized first.",
  NotSuccessful: "Only successful campaigns pay out to the creator.",
  NotFailed: "Refunds are only available for failed campaigns.",
  NotCreator: "Only the campaign creator can claim the payout.",
  AlreadyClaimed: "This has already been claimed.",
  NothingToClaim: "There is nothing to claim for this account.",
  ZeroAmount: "The amount must be greater than zero.",
  UnknownCampaign: "This campaign does not exist.",
  InvalidGoal: "The goal must be greater than zero and at most the total KT supply.",
  InvalidDuration: "The duration must be between 60 seconds and 365 days.",
  InvalidName: "The name must be 1 to 64 UTF-8 bytes.",
  InvalidDescription: "The description must be at most 500 UTF-8 bytes.",
  ReceivedAmountMismatch: "The token transfer delivered an unexpected amount.",
  ZeroPurchase: "Send more than 0 ETH to buy KT.",
  InsufficientReserve: "Not enough KT left in the sale reserve for this purchase.",
  NoProceeds: "There are no recorded sale proceeds to withdraw.",
  EthTransferFailed: "The ETH transfer to the owner failed.",
  RenounceDisabled: "Renouncing ownership is disabled.",
  "Ownable: caller is not the owner": "Only the current on-chain owner can do this.",
  "ERC20: transfer amount exceeds balance": "Your KT balance is too low for this amount.",
  "ERC20: insufficient allowance": "The approved KT allowance is too low. Approve the required amount first.",
};

export function isUserRejection(err) {
  const codes = [err?.code, err?.error?.code, err?.info?.error?.code, err?.cause?.code];
  return codes.includes("ACTION_REJECTED") || codes.includes(4001);
}

function revertData(err) {
  return err?.data ?? err?.error?.data ?? err?.info?.error?.data ?? err?.revert?.data;
}

/** Extract the custom error name or revert reason string, if any. */
export function revertName(err, interfaces = []) {
  if (err?.revert?.name) {
    if (err.revert.name === "Error") return String(err.revert.args?.[0] ?? "Error");
    if (err.revert.name === "Panic") return `Panic(${err.revert.args?.[0]})`;
    return err.revert.name;
  }
  const data = revertData(err);
  if (typeof data === "string" && data.length >= 10) {
    for (const iface of interfaces) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) return parsed.name === "Error" ? String(parsed.args[0]) : parsed.name;
      } catch {
        /* not this interface */
      }
    }
  }
  if (typeof err?.reason === "string" && err.reason) return err.reason;
  return null;
}

/** @returns {{ kind: 'rejected'|'revert'|'insufficient-funds'|'network'|'unknown', name?: string, message: string }} */
export function describeError(err, interfaces = []) {
  if (isUserRejection(err)) {
    return { kind: "rejected", message: "You rejected the request in your wallet. Nothing was submitted." };
  }
  const name = revertName(err, interfaces);
  if (name) return { kind: "revert", name, message: MESSAGES[name] ?? name };
  const text = `${err?.shortMessage ?? ""} ${err?.message ?? ""}`;
  if (err?.code === "INSUFFICIENT_FUNDS" || /insufficient funds/i.test(text)) {
    return { kind: "insufficient-funds", message: "Your local ETH balance cannot cover this amount plus gas." };
  }
  if (err?.code === "NETWORK_ERROR" || err?.code === "SERVER_ERROR" || /failed to fetch|ECONNREFUSED|network/i.test(text)) {
    return { kind: "network", message: "The local RPC is unavailable." };
  }
  return { kind: "unknown", message: err?.shortMessage || err?.message || "Unknown error." };
}
