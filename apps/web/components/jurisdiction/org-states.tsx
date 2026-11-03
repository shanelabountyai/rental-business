'use client'

import { US_STATE_OPTIONS } from '@rental/core/property'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { OrgStateFormState } from '@/lib/jurisdiction/actions.ts'

type Action = (state: OrgStateFormState, formData: FormData) => Promise<OrgStateFormState>

export type OrgStateRow = { state: string; counselReviewedBy: string | null; counselReviewedOn: string | null }

// R-298a (PRD 10 §7.2, D-389): the org's own states. Each form's result
// region is mounted outside anything its action changes, so a press that
// moves a state from "unreviewed" to "reviewed" still shows its notice.
export function OrgStates({
  rows,
  canConfigure,
  enable,
  review,
}: {
  rows: OrgStateRow[]
  canConfigure: boolean
  enable: Action
  review: Action
}) {
  const [enableState, enableAction] = useActionState(enable, {})
  const [reviewState, reviewAction] = useActionState(review, {})
  const enabled = new Set(rows.map((r) => r.state))
  return (
    <section aria-labelledby="org-states-heading" className="flex flex-col gap-3 rounded-md border p-4 text-sm">
      <h2 id="org-states-heading" className="text-lg font-semibold">
        Your organisation&apos;s states
      </h2>
      <p className="text-muted-foreground max-w-prose">
        A property can only be added in a state enabled here. Until an owner records your own counsel&apos;s review
        of a state&apos;s rules, every notice for a property there says it has not been reviewed.
      </p>
      <FormAlerts state={reviewState} />
      {rows.length === 0 ? (
        <p>No states enabled yet.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {rows.map((row) => (
            <li key={row.state} className="flex flex-col gap-2 px-4 py-3 break-words">
              <span className="font-medium">
                {row.state} ·{' '}
                {row.counselReviewedBy
                  ? `counsel review recorded: ${row.counselReviewedBy}, ${row.counselReviewedOn}`
                  : 'counsel review not recorded'}
              </span>
              {canConfigure && (
                <form action={reviewAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <input type="hidden" name="state" value={row.state} />
                  <TextField label={`Counsel who reviewed ${row.state}`} name="reviewedBy" required />
                  <TextField label={`Date of the ${row.state} review`} name="reviewedOn" type="date" required />
                  <div>
                    <SubmitButton label={`Record ${row.state} review`} />
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {canConfigure && (
        <form action={enableAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <SelectField
            label="State to enable"
            name="state"
            required
            options={US_STATE_OPTIONS.filter((s) => !enabled.has(s.code)).map((s) => ({
              value: s.code,
              label: `${s.code} — ${s.name}`,
            }))}
          />
          <div>
            <SubmitButton label="Enable state" />
          </div>
        </form>
      )}
      <FormAlerts state={enableState} />
    </section>
  )
}
