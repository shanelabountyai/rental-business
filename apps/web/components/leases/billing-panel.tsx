"use client";

import { formatCents } from "@rental/core/money";
import type { CollectionMethod } from "@rental/core/payments";
import { useActionState } from "react";
import { Badge } from "@/components/badge.tsx";
import { FormAlerts, SubmitButton } from "@/components/auth-form.tsx";
import { SelectField, TextField } from "@/components/form/field.tsx";
import { Panel } from "@/components/panel.tsx";
import type { BillingFormState } from "@/lib/billing/actions.ts";
import type { WorkOrderFormState } from "@/lib/workorders/actions.ts";

// A lease's billing state (D-11, R-034).
//
// A client component since R-036 gave it a re-sync button - the drift action
// the backlog asks for, on the screen where somebody notices the drift.
//
// SAYS WHICH PROVIDER IT IS, LOUDLY, when that is not real Stripe. A screen
// showing plausible `cus_`/`sub_` ids with no indication they came from a
// simulator is how somebody concludes billing is live when it is not - and
// the ids are deliberately Stripe-shaped precisely so that everything
// downstream is exercised against realistic values, which makes the label
// the only thing telling them apart.

export interface PayerBillingView {
  id: string;
  name: string;
  payerType: string;
  portionCents: number | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  collectionMethod: CollectionMethod;
}

// D-29's two modes, in the words a person uses rather than Stripe's. The
// vocabulary matters on this screen: "charge_automatically" tells a PM
// nothing about the only difference they care about, which is whether the
// tenant can pay part of it.
const METHOD_LABELS: Record<CollectionMethod, string> = {
  charge_automatically: "Charged automatically on the billing day",
  send_invoice: "Invoiced — they can pay in parts",
};

/// ONE FORM WITH A SELECT, not a control beside each payer: a per-payer form
/// would repeat its three labels and its button name once per payer, and two
/// controls sharing an accessible name on one assembled page is the collision
/// `/leases/[id]` has now collected five of.
function CollectionMethodForm({
  action,
  payers,
}: {
  action: (
    state: WorkOrderFormState,
    formData: FormData,
  ) => Promise<WorkOrderFormState>;
  payers: readonly PayerBillingView[];
}) {
  const [state, formAction] = useActionState<WorkOrderFormState, FormData>(
    action,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col gap-3 border-t pt-3">
      <FormAlerts state={state} />
      <p className="text-sm font-medium">
        Change how a payer is collected from
      </p>
      <SelectField
        label="Which payer is changing"
        name="leasePayerId"
        required
        idPrefix="collection"
        options={payers.map((p) => ({ value: p.id, label: p.name }))}
      />
      <SelectField
        label="What they should move to"
        name="collectionMethod"
        required
        idPrefix="collection"
        options={(Object.keys(METHOD_LABELS) as CollectionMethod[]).map(
          (m) => ({
            value: m,
            label: METHOD_LABELS[m],
          }),
        )}
      />
      <TextField
        label="Why the collection method is changing"
        name="reason"
        required
        idPrefix="collection"
        error={state.fieldErrors?.reason}
      />
      <SubmitButton label="Change how this payer is billed" />
    </form>
  );
}

export function BillingPanel({
  leaseId,
  payers,
  live,
  providerName,
  resync,
  canSwitchCollection,
  switchCollection,
}: {
  leaseId: string;
  payers: readonly PayerBillingView[];
  live: boolean;
  providerName: string;
  resync: (
    state: BillingFormState,
    formData: FormData,
  ) => Promise<BillingFormState>;
  canSwitchCollection: boolean;
  switchCollection: (
    state: WorkOrderFormState,
    formData: FormData,
  ) => Promise<WorkOrderFormState>;
}) {
  const [state, action] = useActionState<BillingFormState, FormData>(
    resync,
    {},
  );

  return (
    <Panel
      headingId="billing"
      title="Billing"
      trailing={
        !live && (
          <Badge tone="warning">{providerName} provider — not real Stripe</Badge>
        )
      }
    >

      {payers.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing yet. A Stripe customer and subscription open when the tenancy
          goes live.
        </p>
      ) : (
        <ul className="flex flex-col divide-y text-sm">
          {payers.map((payer) => (
            <li key={payer.id} className="flex flex-col gap-1 py-2">
              <span>
                {payer.name}
                <span className="text-muted-foreground">
                  {" · "}
                  {payer.payerType === "TENANT"
                    ? "tenant"
                    : payer.payerType.toLowerCase()}
                  {" · "}
                  {payer.portionCents == null
                    ? "pays the balance"
                    : `${formatCents(payer.portionCents)} of the rent`}
                </span>
              </span>
              {/* "Currently:", and it is not decoration. The switch form's
                  own <option> carries this same sentence, so the bare label
                  appeared twice on the page and resolved to two elements -
                  the collision `/leases/[id]` has now collected six of, and
                  the first one found between a status line and a control
                  rather than between two controls. The prefix is also the
                  better line: it says this is today's state, not an offer. */}
              <span className="text-muted-foreground">
                Currently: {METHOD_LABELS[payer.collectionMethod]}
              </span>
              {payer.stripeSubscriptionId ? (
                <span className="text-muted-foreground font-mono text-xs">
                  {payer.stripeCustomerId} · {payer.stripeSubscriptionId}
                </span>
              ) : (
                <span className="text-sm text-warning">
                  No subscription yet — nothing will bill for this payer.
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <FormAlerts state={state} />

      {payers.length > 0 && (
        <form action={action}>
          <input type="hidden" name="leaseId" value={leaseId} />
          <SubmitButton label="Re-sync with Stripe" />
        </form>
      )}

      {canSwitchCollection && payers.length > 0 && (
        <CollectionMethodForm action={switchCollection} payers={payers} />
      )}

      <p className="text-muted-foreground text-xs">
        Stripe is the source of truth for invoices and payments (D-11). What
        shows on the ledger here is a projection of what Stripe reports, never
        written directly.
      </p>
    </Panel>
  );
}
