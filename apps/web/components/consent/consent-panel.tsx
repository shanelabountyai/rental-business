"use client";

import {
  BASIS_DESCRIPTIONS,
  BASIS_LABELS,
  CONSENT_BASES,
  CONSENT_CHANNELS,
  type ConsentBasisName,
  type ConsentChannelName,
} from "@rental/core/consent";
import { useActionState, useState } from "react";
import { FormAlerts, SubmitButton } from "@/components/auth-form.tsx";
import { SelectField, TextareaField } from "@/components/form/field.tsx";
import type { ConsentFormState } from "@/lib/consent/actions.ts";

// The TCPA consent surface (COMM-02, R-051b, wired R-143).
//
// R-051b built the actions, the CHECK constraint, the append-only trigger and
// the core verdict, and `send.ts` has gated every tenant SMS on the result
// since. What it never built was anywhere to press. `recordConsent` and
// `withdrawConsent` had no caller and no test that called them, so no
// TenantConsent row could exist outside a fixture and every tenant SMS in a
// deployed environment was SUPPRESSED as `no_consent` - correctly, and
// permanently.
//
// TWO FORMS, BOTH WITH A SELECT, NOT A FORM PER ROW. A withdraw form beside
// each row would repeat its labels and its button name once per consent, and
// two controls on one page must never share an accessible name - the lease
// page has collected four of those collisions already. A select names each
// consent once, in one place, and the labels are unique by construction.
//
// Both actions read their id from the form rather than a bound argument, the
// shape `endRecurringCharge` settled on: one action serves every row.

type Action = (
  state: ConsentFormState,
  formData: FormData,
) => Promise<ConsentFormState>;

const CHANNEL_LABELS: Record<ConsentChannelName, string> = {
  SMS: "Text message",
  EMAIL: "Email",
  VOICE: "Phone call",
};

export interface ConsentRow {
  id: string;
  tenantId: string;
  tenantName: string;
  channel: ConsentChannelName;
  basis: ConsentBasisName;
  recordedOn: string;
  recordedByName: string | null;
  note: string | null;
  hasDisclosure: boolean;
  revokedOn: string | null;
  revokeReason: string | null;
}

function RecordConsentForm({
  action,
  tenants,
}: {
  action: Action;
  tenants: readonly { id: string; name: string }[];
}) {
  const [state, formAction] = useActionState<ConsentFormState, FormData>(
    action,
    {},
  );
  const [basis, setBasis] = useState<ConsentBasisName | "">("");

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <FormAlerts state={state} />

      <SelectField
        label="Which tenant agreed"
        name="tenantId"
        required
        idPrefix="consent-record"
        options={tenants.map((t) => ({ value: t.id, label: t.name }))}
      />
      <SelectField
        label="What they agreed to be contacted on"
        name="channel"
        required
        idPrefix="consent-record"
        options={CONSENT_CHANNELS.map((c) => ({
          value: c,
          label: CHANNEL_LABELS[c],
        }))}
      />
      <SelectField
        label="How that consent was obtained"
        name="basis"
        required
        idPrefix="consent-record"
        options={CONSENT_BASES.map((b) => ({
          value: b,
          label: BASIS_LABELS[b],
        }))}
        onChange={(event) => setBasis(event.target.value as ConsentBasisName)}
      />

      {/* The description sits under the choice rather than in the option text:
          a `<select>` option cannot carry two lines, and these four look
          interchangeable without the sentence that separates them. */}
      {basis && (
        <p className="text-muted-foreground text-sm">
          {BASIS_DESCRIPTIONS[basis]}
        </p>
      )}

      {/* ALWAYS RENDERED, never hidden behind the basis. The action refuses
          EXPRESS_WRITTEN with no disclosure, and a field that appears only
          once the select changes is unreachable before hydration - which is
          when the refusal would fire. */}
      <TextareaField
        label="The wording the tenant was shown"
        name="disclosureText"
        rows={3}
        idPrefix="consent-record"
        hint="Required for express written consent, which is the only basis that permits marketing messages. Optional for the others."
      />
      <TextareaField
        label="Note about how this consent was captured"
        name="note"
        rows={2}
        idPrefix="consent-record"
      />

      <SubmitButton label="Record this consent" />
    </form>
  );
}

function WithdrawConsentForm({
  action,
  live,
}: {
  action: Action;
  live: readonly ConsentRow[];
}) {
  const [state, formAction] = useActionState<ConsentFormState, FormData>(
    action,
    {},
  );

  // MOUNTED EVEN WITH NOTHING LEFT TO WITHDRAW. Withdrawing the last consent
  // in force empties `live`, and a form rendered behind `live.length > 0`
  // would unmount in the same pass that produced its own confirmation -
  // R-044's trap, where the press that took the last row also took the
  // sentence saying so off the screen. The fields go; the regions stay.
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <FormAlerts state={state} />

      {live.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing is in force to withdraw.
        </p>
      ) : (
        <>
          <SelectField
            label="Which consent is being withdrawn"
            name="consentId"
            required
            idPrefix="consent-withdraw"
            options={live.map((row) => ({
              value: row.id,
              label: `${row.tenantName} — ${CHANNEL_LABELS[row.channel]}, recorded ${row.recordedOn}`,
            }))}
          />
          <TextareaField
            label="Why the consent is being withdrawn"
            name="revokeReason"
            required
            rows={2}
            idPrefix="consent-withdraw"
            hint="Required. A withdrawal with no stated reason cannot be told from a mistake somebody made on this screen."
          />

          <SubmitButton label="Withdraw this consent" />
        </>
      )}
    </form>
  );
}

export function ConsentPanel({
  consents,
  tenants,
  canManage,
  recordAction,
  withdrawAction,
}: {
  consents: readonly ConsentRow[];
  tenants: readonly { id: string; name: string }[];
  canManage: boolean;
  recordAction: Action;
  withdrawAction: Action;
}) {
  const live = consents.filter((row) => row.revokedOn === null);

  return (
    <section
      aria-labelledby="tenant-consent"
      className="flex flex-col gap-4 border-t pt-4"
    >
      <h2 id="tenant-consent" className="text-lg font-semibold">
        Permission to contact
      </h2>

      <p className="text-muted-foreground text-sm">
        A text message to a tenant is sent only where this record says they
        agreed to receive one (47 U.S.C. §227). Without a row here every text to
        that tenant is held back and recorded as having no consent — email and
        the tenant portal are unaffected.
      </p>

      {consents.length === 0 ? (
        <p className="text-sm">
          Nobody on this lease has agreed to be contacted yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {consents.map((row) => (
            <li key={row.id} className="rounded border p-3 text-sm">
              <p className="font-medium">
                {row.tenantName} — {CHANNEL_LABELS[row.channel]}
              </p>
              <p className="text-muted-foreground">{BASIS_LABELS[row.basis]}</p>
              <p className="text-muted-foreground">
                Recorded {row.recordedOn}
                {row.recordedByName ? ` by ${row.recordedByName}` : ""}
                {row.hasDisclosure ? ", with the wording they were shown" : ""}
              </p>
              {row.note && <p className="text-muted-foreground">{row.note}</p>}
              {row.revokedOn ? (
                <p className="mt-1 font-medium text-amber-900">
                  {/* "Consent in effect", not "In force": the holds panel two
                      sections down already renders "in force" and "N in
                      force", and getByText is a case-insensitive SUBSTRING
                      match - two controls or two texts sharing a name on one
                      assembled page is the collision this page has collected
                      four of. */}
                  Consent withdrawn {row.revokedOn}
                  {row.revokeReason ? ` — ${row.revokeReason}` : ""}
                </p>
              ) : (
                <p className="mt-1 font-medium text-green-900">Consent in effect</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <RecordConsentForm action={recordAction} tenants={tenants} />
      )}
      {canManage && <WithdrawConsentForm action={withdrawAction} live={live} />}
    </section>
  );
}
