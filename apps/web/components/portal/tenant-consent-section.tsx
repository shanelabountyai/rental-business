"use client";

import {
  BASIS_DESCRIPTIONS,
  BASIS_LABELS,
  type ConsentBasisName,
  type ConsentChannelName,
} from "@rental/core/consent";
import { useActionState } from "react";
import { LiveRegion } from "@/components/auth-form.tsx";
import type { ConsentFormState } from "@/lib/consent/actions.ts";

// A tenant's own permission-to-contact record (R-164).
//
// READ AND WITHDRAW ONLY - no "record consent" form here. Recording is an
// evidentiary act staff perform and attribute to themselves
// (components/consent/consent-panel.tsx's own header says so); a tenant
// asserting their own consent from this screen would be a self-report with
// no witness, which is not what the basis column is for.
//
// ONE SELECT, NOT A FORM PER ROW - the same reasoning ConsentPanel's
// withdraw form gives: a control per row repeats its label and button name
// once per row, and two controls sharing an accessible name is the
// collision this codebase has hit repeatedly.

const CHANNEL_LABELS: Record<ConsentChannelName, string> = {
  SMS: "Text message",
  EMAIL: "Email",
  VOICE: "Phone call",
};

export interface OwnConsentRow {
  id: string;
  channel: ConsentChannelName;
  basis: ConsentBasisName;
  recordedOn: string;
  revokedOn: string | null;
  revokeReason: string | null;
}

export function TenantConsentSection({
  consents,
  withdrawAction,
}: {
  consents: readonly OwnConsentRow[];
  withdrawAction: (
    state: ConsentFormState,
    formData: FormData,
  ) => Promise<ConsentFormState>;
}) {
  const [state, formAction] = useActionState<ConsentFormState, FormData>(
    withdrawAction,
    {},
  );
  const live = consents.filter((row) => row.revokedOn === null);

  return (
    <section
      aria-labelledby="consent"
      className="flex flex-col gap-4 border-t pt-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id="consent" className="text-lg font-semibold">
          Permission to contact
        </h2>
        <p className="text-muted-foreground text-base">
          What we have on file for texting or calling you, and why. You can
          withdraw any of these at any time.
        </p>
      </div>

      {consents.length === 0 ? (
        <p className="text-base">Nothing is on file yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {consents.map((row) => (
            <li key={row.id} className="rounded-lg border p-4 text-base">
              <p className="font-medium">{CHANNEL_LABELS[row.channel]}</p>
              <p className="text-muted-foreground">{BASIS_LABELS[row.basis]}</p>
              <p className="text-muted-foreground text-sm">
                {BASIS_DESCRIPTIONS[row.basis]}
              </p>
              <p className="text-muted-foreground text-sm">
                Recorded {row.recordedOn}
              </p>
              {row.revokedOn ? (
                <p className="mt-1 font-medium">
                  Withdrawn {row.revokedOn}
                  {row.revokeReason ? ` — ${row.revokeReason}` : ""}
                </p>
              ) : (
                <p className="mt-1 font-medium">In effect</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* MOUNTED EVEN WITH NOTHING LEFT TO WITHDRAW - withdrawing the last
          live consent empties `live` in the same pass, and a form behind
          `live.length > 0` would take its own confirmation off the screen
          with it (R-044's trap; ConsentPanel makes the same choice). */}
      <form action={formAction} className="flex flex-col gap-3">
        <LiveRegion assertive>
          {state.error && <p className="text-base text-red-700">{state.error}</p>}
        </LiveRegion>
        <LiveRegion>
          {state.notice && <p className="text-base">{state.notice}</p>}
        </LiveRegion>

        {live.length === 0 ? (
          <p className="text-muted-foreground text-base">
            Nothing is in effect to withdraw.
          </p>
        ) : (
          <>
            <label htmlFor="consentId" className="text-base font-medium">
              Withdraw permission to
            </label>
            <select
              id="consentId"
              name="consentId"
              required
              className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              {live.map((row) => (
                <option key={row.id} value={row.id}>
                  {CHANNEL_LABELS[row.channel]} — recorded {row.recordedOn}
                </option>
              ))}
            </select>
            <label htmlFor="revokeReason" className="text-base font-medium">
              Why you are withdrawing this
            </label>
            <textarea
              id="revokeReason"
              name="revokeReason"
              required
              rows={2}
              className="border-input bg-background focus-visible:ring-ring rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            />
            <button
              type="submit"
              className="border-input hover:bg-secondary focus-visible:ring-ring flex min-h-11 w-fit items-center rounded-md border px-4 py-2 text-base font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              Withdraw
            </button>
          </>
        )}
      </form>
    </section>
  );
}
