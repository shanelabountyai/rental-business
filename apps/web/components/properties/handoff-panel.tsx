'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { HandoffState } from '@/lib/properties/handoff-actions.ts'

// The sale / acquisition handoff (DOC-06, RISK-09; R-092).
//
// TWO BUTTONS, IN THE ORDER THEY HAVE TO BE PRESSED, and the panel says why
// rather than leaving somebody to discover it from an exhibit index that
// reads "[NOT ATTACHED]". Generating certificates first is not a technical
// constraint invented here - a buyer asks for one per tenancy, each one has
// to go out to a tenant and come back signed, and that takes days the packet
// does not wait for.

type Action = (state: HandoffState, formData: FormData) => Promise<HandoffState>

export function HandoffPanel({
  leaseCount,
  estoppelCount,
  packets,
  generateAction,
  archiveAction,
}: {
  leaseCount: number
  estoppelCount: number
  packets: readonly { id: string; fileName: string; createdOn: string }[]
  generateAction: Action
  archiveAction: Action
}) {
  const [generateState, generate] = useActionState<HandoffState, FormData>(generateAction, {})
  const [archiveState, archive] = useActionState<HandoffState, FormData>(archiveAction, {})

  return (
    <section aria-labelledby="handoff" className="flex flex-col gap-4 rounded-md border p-4">
      <div className="flex flex-col gap-1">
        <h2 id="handoff" className="text-sm font-semibold">
          Sale and acquisition handoff
        </h2>
        <p className="text-muted-foreground text-sm">
          The whole file for this property in one document: the tenancies and what they pay, the
          deposits held and who they belong to, the keys on file, the work that has been done and
          what is warranted — plus a draft notice for each tenant telling them their deposit
          moved.
        </p>
      </div>

      <div className="flex flex-col gap-2 border-t pt-3">
        <h3 className="text-sm font-medium">1. Estoppel certificates</h3>
        <FormAlerts state={generateState} />
        <p className="text-muted-foreground text-sm">
          One per running tenancy, for the tenant to sign and a buyer&rsquo;s lender to rely on.
          {leaseCount === 0
            ? ' No tenancy is running here, so there is nothing to certify.'
            : ` ${estoppelCount} generated so far, for ${leaseCount} ${leaseCount === 1 ? 'tenancy' : 'tenancies'}.`}
        </p>
        <form action={generate}>
          <SubmitButton label="Generate the estoppel certificates" />
        </form>
      </div>

      <div className="flex flex-col gap-2 border-t pt-3">
        <h3 className="text-sm font-medium">2. The handoff packet</h3>
        <FormAlerts state={archiveState} />
        {/* Said before the click, not discovered afterwards on the index. */}
        <p className="text-muted-foreground text-sm">
          The packet attaches whatever certificates exist and names any tenancy without one, so
          generating them first is worth the wait. Access codes are listed but never printed —
          those are handed over in person.
        </p>
        <form action={archive}>
          <SubmitButton label="Assemble the handoff packet" />
        </form>
      </div>

      {packets.length > 0 && (
        <div className="flex flex-col gap-2 border-t pt-3">
          <h3 className="text-sm font-medium">Packets already assembled</h3>
          {/* Every export kept, never overwritten: a packet is a claim about
              the file on a date, and the date somebody was handed one is the
              question afterwards. */}
          <ul className="flex flex-col gap-1 text-sm">
            {packets.map((packet) => (
              <li key={packet.id}>
                <Link
                  href={`/api/documents/${packet.id}/file`}
                  className="underline underline-offset-4"
                >
                  {packet.fileName}
                </Link>{' '}
                <span className="text-muted-foreground">— {packet.createdOn}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
