import { useState } from "react";
import { Link } from "react-router-dom";
import { Field, Notice, TxStatus } from "../components/common.jsx";
import { TxState } from "../lib/tx.js";
import { MAX_DESCRIPTION_BYTES, MAX_NAME_BYTES, TOTAL_SUPPLY, formatKT, parseAmount, parseDuration, utf8Length } from "../lib/units.js";
import { useApp, useTx } from "../state/AppContext.js";

export function validateCampaignForm(form) {
  const errors = {};
  const nameBytes = utf8Length(form.name);
  if (nameBytes === 0) errors.name = "Enter a name.";
  else if (nameBytes > MAX_NAME_BYTES) errors.name = `The name is ${nameBytes} UTF-8 bytes, but the maximum is ${MAX_NAME_BYTES}.`;
  const descBytes = utf8Length(form.description);
  if (descBytes > MAX_DESCRIPTION_BYTES) errors.description = `The description is ${descBytes} UTF-8 bytes, but the maximum is ${MAX_DESCRIPTION_BYTES}.`;
  const goal = parseAmount(form.goal);
  if (goal.error) errors.goal = goal.error;
  else if (goal.value > TOTAL_SUPPLY) errors.goal = `The goal cannot exceed the total supply (${formatKT(TOTAL_SUPPLY)}).`;
  const duration = parseDuration(form);
  if (duration.error) errors.duration = duration.error;
  return { errors, goal: goal.value, duration: duration.value, nameBytes, descBytes };
}

export function CreatePage() {
  const { actions, writeBlockedReason } = useApp();
  const tx = useTx("create");
  const [form, setForm] = useState({ name: "", description: "", goal: "", days: "7", hours: "0", minutes: "0" });
  const [touched, setTouched] = useState(false);
  const v = validateCampaignForm(form);
  const valid = Object.keys(v.errors).length === 0;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const show = (k) => (touched || form[k] !== "" ? v.errors[k] : undefined);

  const submit = (e) => {
    e.preventDefault();
    setTouched(true);
    if (!valid || writeBlockedReason) return;
    tx.run((u) => actions.createCampaign({ goal: v.goal, duration: v.duration, name: form.name, description: form.description }, u));
  };

  return (
    <section className="card narrow" aria-labelledby="create-title">
      <h1 id="create-title">Create a campaign</h1>
      <form onSubmit={submit} noValidate>
        <Field id="name" label={`Name (${v.nameBytes}/${MAX_NAME_BYTES} UTF-8 bytes)`} error={show("name")}>
          <input id="name" value={form.name} onChange={set("name")} data-testid="name-input" />
        </Field>
        <Field id="description" label={`Description (${v.descBytes}/${MAX_DESCRIPTION_BYTES} UTF-8 bytes, optional)`} error={show("description")}>
          <textarea id="description" rows={4} value={form.description} onChange={set("description")} data-testid="description-input" />
        </Field>
        <Field id="goal" label="Funding goal (KT)" hint="Exact decimal amount, greater than 0 and at most 1,000,000 KT." error={show("goal")}>
          <input id="goal" inputMode="decimal" value={form.goal} onChange={set("goal")} data-testid="goal-input" />
        </Field>
        <fieldset className="duration">
          <legend>Duration (60 seconds to 365 days)</legend>
          {["days", "hours", "minutes"].map((k) => (
            <label key={k}>
              {k[0].toUpperCase() + k.slice(1)}
              <input inputMode="numeric" value={form[k]} onChange={set(k)} data-testid={`${k}-input`} />
            </label>
          ))}
          {v.errors.duration && <p className="field-error" role="alert">{v.errors.duration}</p>}
        </fieldset>
        {writeBlockedReason && <p className="muted">{writeBlockedReason}</p>}
        <button type="submit" className="btn" disabled={!valid || !!writeBlockedReason || tx.busy} data-testid="create-button">Create campaign</button>
      </form>
      <TxStatus tx={tx} />
      {tx.record?.state === TxState.CONFIRMED && (
        <Notice tone="ok" testId="created-link">
          Campaign <Link to={`/campaigns/${tx.record.result.id}`}>#{String(tx.record.result.id)}</Link> was created and verified on-chain.
        </Notice>
      )}
    </section>
  );
}
