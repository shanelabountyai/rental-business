'use client'

import { useActionState } from 'react'
import { LiveRegion, pendingButtonProps } from '@/components/auth-form.tsx'
import { FieldError } from '@/components/form/field.tsx'
import { Panel } from '@/components/panel.tsx'
import type { TemplateFormState } from '@/lib/comms/template-actions.ts'

// Version history, restore and duplicate for a managed template (R-264).
//
// The result regions sit OUTSIDE the version list: a restore adds a row to
// that list, and a live region that arrives already holding its text
// announces nothing (R-101).

type Action = (previous: TemplateFormState, formData: FormData) => Promise<TemplateFormState>

export interface VersionRow {
  id: string
  version: number
  name: string
  subject: string | null
  body: string
  savedAt: string
  savedByName: string
  restoredFromVersion: number | null
}

const BUTTON_CLASSES =
  'focus-visible:ring-ring border-input min-h-11 self-start rounded-md border px-4 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none'

export function TemplateHistoryPanel({
  versions,
  restoreAction,
  duplicateAction,
}: {
  versions: VersionRow[]
  restoreAction: Action
  duplicateAction: Action
}) {
  const [restoreState, restore, restorePending] = useActionState<TemplateFormState, FormData>(
    restoreAction,
    {},
  )
  const [duplicateState, duplicate, duplicatePending] = useActionState<TemplateFormState, FormData>(
    duplicateAction,
    {},
  )

  return (
    <Panel headingId="history" title="History" gap="gap-4">
      <p className="text-muted-foreground text-sm">
        Every saved version, newest first. Restoring one saves it again as a new version, so nothing
        here is ever lost.
      </p>

      <FieldError id="restore-error" message={restoreState.error} />
      <LiveRegion>{restoreState.notice && <p className="text-sm">{restoreState.notice}</p>}</LiveRegion>

      {versions.length === 0 ? (
        <p className="text-muted-foreground text-sm">No versions saved yet.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {versions.map((row, index) => (
            <li key={row.id} className="rounded-lg border p-3 break-words">
              <p className="text-sm font-medium">
                Version {row.version}
                {index === 0 && <span className="text-muted-foreground font-normal"> — current</span>}
              </p>
              <p className="text-muted-foreground text-sm">
                {row.savedAt} by {row.savedByName}
                {row.restoredFromVersion !== null && ` · restored from version ${row.restoredFromVersion}`}
              </p>
              <details className="mt-2">
                <summary className="cursor-pointer text-sm underline underline-offset-2">
                  Show the words in version {row.version}
                </summary>
                <dl className="mt-2 flex flex-col gap-1 text-sm">
                  <dt className="font-medium">Name</dt>
                  <dd>{row.name}</dd>
                  {row.subject && (
                    <>
                      <dt className="font-medium">Subject</dt>
                      <dd>{row.subject}</dd>
                    </>
                  )}
                  <dt className="font-medium">Message</dt>
                  <dd className="whitespace-pre-wrap">{row.body}</dd>
                </dl>
              </details>
              {index > 0 && (
                <form action={restore} className="mt-2">
                  <input type="hidden" name="versionId" value={row.id} />
                  <button type="submit" {...pendingButtonProps(restorePending)} className={BUTTON_CLASSES}>
                    Restore version {row.version}
                  </button>
                </form>
              )}
            </li>
          ))}
        </ol>
      )}

      <form action={duplicate} className="flex flex-col gap-2 border-t pt-4">
        <p className="text-muted-foreground text-sm">
          Start a new template from this one. Translations are copied but need approving again.
        </p>
        <FieldError id="duplicate-error" message={duplicateState.error} />
        <button type="submit" {...pendingButtonProps(duplicatePending)} className={BUTTON_CLASSES}>
          Duplicate this template
        </button>
      </form>
    </Panel>
  )
}
