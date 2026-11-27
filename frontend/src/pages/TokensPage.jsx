import { useState } from "react";
import { Field, Notice, QueryState, TxStatus, UnsolicitedWarning } from "../components/common.jsx";
import { formatEth, formatKT, ktForWei, parseAmount } from "../lib/units.js";
import { useApp, useChainQuery, useTx } from "../state/AppContext.js";

export function TokensPage() {
  const { actions, wallet, writeBlockedReason } = useApp();
  const account = wallet.status === "connected" ? wallet.account : null;
  const tx = useTx("tokens");
  const [raw, setRaw] = useState("");
  const q = useChainQuery(
    async (api) => ({
      reserve: await api.token.saleReserve(),
      eth: account ? await api.provider.getBalance(account) : null,
      kt: account ? await api.token.balanceOf(account) : null,
    }),
    [account]
  );

  return (
    <section className="card narrow" aria-labelledby="tokens-title">
      <h1 id="tokens-title">Get KreativeToken (KT)</h1>
      <Notice tone="warn">KT is an educational token with no promised monetary value, no redemption rights and no real-world backing. Use local development ETH only.</Notice>
      <QueryState state={q}>
        {(d) => {
          const parsed = raw === "" ? null : parseAmount(raw);
          let error = parsed?.error ?? null;
          const tokens = parsed?.value !== undefined ? ktForWei(parsed.value) : null;
          if (!error && tokens !== null && tokens > d.reserve) error = `Only ${formatKT(d.reserve)} remain in the sale reserve.`;
          if (!error && parsed?.value !== undefined && d.eth !== null && parsed.value > d.eth) error = `Your ETH balance (${formatEth(d.eth)}) is too low.`;
          const ready = parsed?.value !== undefined && !error;
          return (
            <>
              <dl className="facts">
                <div><dt>Fixed educational rate</dt><dd>100 KT per 1 local ETH (1 wei = 100 base units)</dd></div>
                <div><dt>Remaining sale reserve</dt><dd data-testid="reserve">{formatKT(d.reserve)}</dd></div>
                {account && <div><dt>Your local ETH</dt><dd data-testid="eth-balance">{formatEth(d.eth)}</dd></div>}
                {account && <div><dt>Your KT</dt><dd data-testid="kt-balance">{formatKT(d.kt)}</dd></div>}
              </dl>
              <Field id="eth" label="Pay (local ETH)" hint="Exact decimal, up to 18 decimal places. Gas is paid separately." error={error}>
                <input id="eth" inputMode="decimal" value={raw} onChange={(e) => setRaw(e.target.value)} data-testid="eth-input" />
              </Field>
              {tokens !== null && !error && <p data-testid="kt-preview">You receive exactly {formatKT(tokens)}.</p>}
              {writeBlockedReason && <p className="muted">{writeBlockedReason}</p>}
              <button type="button" className="btn" disabled={!ready || !!writeBlockedReason || tx.busy} data-testid="buy-button" onClick={() => tx.run((u) => actions.buyTokens(parsed.value, u))}>
                Buy KT
              </button>
            </>
          );
        }}
      </QueryState>
      <TxStatus tx={tx} />
      <UnsolicitedWarning />
    </section>
  );
}
