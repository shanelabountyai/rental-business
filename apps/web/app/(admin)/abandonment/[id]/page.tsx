import {
  ABANDONMENT_OUTCOME_LABELS,
  ABANDONMENT_STATUS_LABELS,
  assessEvidence,
  CONTACT_METHOD_LABELS,
  CONTACT_OUTCOME_LABELS,
  DECEASED_OUTCOME_PROMPT,
  DISPOSAL_REFUSAL_MESSAGES,
  disposalReadiness,
} from '@rental/core/abandonment'
import {
  businessDate,
  friendlyBusinessDate,
  friendlyDate,
  friendlyTimestamp,
} from '@rental/core/scheduling'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  CloseCasePanel,
  DisposePanel,
  HoldBelongingsPanel,
  LogAttemptPanel,
  RecordEntryPanel,
} from '@/components/abandonment/case-panels.tsx'
import {
  closeAbandonmentCase,
  disposeBelongings,
  holdBelongings,
  logContactAttempt,
  recordEntry,
} from '@/lib/abandonment/actions.ts'
import { daysSinceContact, getAbandonmentCase } from '@/lib/abandonment/queries.ts'
import { requirePermission, requireScope } from '@/lib/auth/guard.ts'
import { balanceCents } from '@rental/core/ledger'
import { prisma } from '@rental/db'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Gone dark — Rental Operations' }

// NO `loading.tsx` HERE OR ABOVE (R-099): this page calls notFound().
export default async function AbandonmentCasePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  // R-103: `requireScope`, never a resource-less `requirePermission` - an
  // empty resource only ever matches a portfolio-wide grant, so the obvious
  // guard locks out every entity- and property-scoped actor. See
  // `requireScope`'s own comment.
  const { actor } = await requireScope('eviction.manage')
  const scope = await currentScope(actor)
  const found = await getAbandonmentCase(id, scope)
  if (!found) notFound()

  const zone = found.timezone
  const today = businessDate(new Date(), zone)
  const rule = await rulesFor({ state: found.state, county: found.county }, new Date()).catch(
    () => null,
  )

  // Is rent actually in arrears? A quiet tenancy that is paid up is not an
  // abandoned one, and several states make that a precondition.
  const entries = await prisma.ledgerEntry.findMany({
    where: { leaseId: found.leaseId },
    select: { id: true, type: true, amountCents: true, occurredAt: true, description: true },
  })
  const balance = balanceCents(entries)

  const evidence = assessEvidence({
    attempts: found.attempts.map((attempt) => ({
      method: attempt.method,
      outcome: attempt.outcome,
    })),
    daysSinceContact: daysSinceContact(found.lastContactOn, today),
    presumedAfterDays: rule?.abandonmentPresumedAfterDays ?? null,
    rentUnpaid: balance > 0,
  })

  const disposal = found.belongingsHeldFrom
    ? disposalReadiness({
        heldFrom: found.belongingsHeldFrom,
        storageDays: rule?.belongingsStorageDays ?? null,
        noticeDays: rule?.belongingsNoticeDays ?? null,
        noticeSentOn: found.belongingsNoticeSentOn,
        today,
      })
    : null

  const openCase = found.status !== 'CLOSED'

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/abandonment"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Gone dark
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {found.propertyName} — {found.unitName}
        </h1>
        <p className="text-muted-foreground text-sm">
          {found.tenantNames.join(', ') || 'No tenant recorded'} ·{' '}
          {found.outcome
            ? ABANDONMENT_OUTCOME_LABELS[found.outcome]
            : ABANDONMENT_STATUS_LABELS[found.status]}{' '}
          · opened {friendlyDate(found.openedAt, zone)} by {found.openedByName}
        </p>
      </header>

      {/* WHAT IS NOT YET TRUE, said plainly and before anything else. The
          product never blocks on this — an operator with a genuine reason to
          move faster should not be arguing with a counter — but the gaps are
          exactly what the other side's solicitor will list. */}
      <section aria-labelledby="evidence" className="flex flex-col gap-2 rounded-md border p-4">
        <h2 id="evidence" className="text-lg font-semibold">
          Where the evidence stands
        </h2>
        <p className="text-sm">
          {found.attempts.length} attempt{found.attempts.length === 1 ? '' : 's'} across{' '}
          {evidence.distinctMethods} method{evidence.distinctMethods === 1 ? '' : 's'}
          {found.lastContactOn
            ? ` · last sign of them ${friendlyBusinessDate(found.lastContactOn)}`
            : ' · no last-contact date recorded'}
        </p>
        {evidence.gaps.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing outstanding on the house checks. That is not legal advice and it never
            was — it means the record looks like somebody tried.
          </p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm text-amber-800">
            {evidence.gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="attempts" className="flex flex-col gap-3 rounded-md border p-4">
        <h2 id="attempts" className="text-lg font-semibold">
          Contact attempts
        </h2>
        {found.attempts.length === 0 ? (
          <p className="text-muted-foreground text-sm">None logged yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {found.attempts.map((attempt) => (
              <li key={attempt.id} className="flex flex-col">
                <span className="font-medium">
                  {friendlyBusinessDate(attempt.attemptedOn)} — {CONTACT_METHOD_LABELS[attempt.method]}
                </span>
                <span className="text-muted-foreground">
                  {CONTACT_OUTCOME_LABELS[attempt.outcome]}
                  {attempt.note && ` · ${attempt.note}`} · logged by {attempt.recordedByName}
                </span>
              </li>
            ))}
          </ul>
        )}
        {openCase && <LogAttemptPanel caseId={found.id} action={logContactAttempt} />}
      </section>

      <section aria-labelledby="entry" className="flex flex-col gap-3 rounded-md border p-4">
        <h2 id="entry" className="text-lg font-semibold">
          The entry
        </h2>
        {found.enteredAt ? (
          <>
            <p className="text-sm">
              Entered {friendlyTimestamp(found.enteredAt, zone)}
              {found.entryNoticeId ? (
                <>
                  {' · '}
                  <Link
                    href={`/notices/${found.entryNoticeId}`}
                    className="underline underline-offset-2"
                  >
                    entry notice
                  </Link>
                </>
              ) : (
                ' · no notice served'
              )}
            </p>
            <p className="text-sm whitespace-pre-wrap">{found.entryFindings}</p>
          </>
        ) : openCase ? (
          <RecordEntryPanel
            caseId={found.id}
            action={recordEntry}
            entryNoticeHours={rule?.entryNoticeHours ?? null}
            state={found.state}
          />
        ) : (
          <p className="text-muted-foreground text-sm">The unit was never entered.</p>
        )}
      </section>

      {found.documents.length > 0 && (
        <section aria-labelledby="photos" className="flex flex-col gap-2 rounded-md border p-4">
          <h2 id="photos" className="text-lg font-semibold">
            Photographs
          </h2>
          <ul className="flex flex-col gap-1 text-sm">
            {found.documents.map((document) => (
              <li key={document.id}>
                <a
                  href={`/api/documents/${document.id}/file`}
                  className="underline underline-offset-2"
                >
                  {document.fileName}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {found.enteredAt && (
        <section
          aria-labelledby="belongings"
          className="flex flex-col gap-3 rounded-md border p-4"
        >
          <h2 id="belongings" className="text-lg font-semibold">
            Their belongings
          </h2>

          {found.belongingsHeldFrom ? (
            <>
              <p className="text-sm">
                Held from {friendlyBusinessDate(found.belongingsHeldFrom)}
                {found.belongingsNoticeSentOn &&
                  ` · notice of disposal sent ${friendlyBusinessDate(found.belongingsNoticeSentOn)}`}
              </p>
              <p className="text-sm whitespace-pre-wrap">{found.belongingsInventory}</p>

              {found.belongingsDisposedAt ? (
                <p className="text-sm">
                  Disposed of {friendlyTimestamp(found.belongingsDisposedAt, zone)}.
                </p>
              ) : (
                openCase && (
                  <DisposePanel
                    caseId={found.id}
                    action={disposeBelongings}
                    refusal={
                      disposal && !disposal.allowed
                        ? `${DISPOSAL_REFUSAL_MESSAGES[disposal.refusal!]}${
                            disposal.earliestOn
                              ? ` The earliest lawful date is ${friendlyBusinessDate(disposal.earliestOn)}.`
                              : ''
                          }`
                        : null
                    }
                  />
                )
              )}
            </>
          ) : (
            openCase && <HoldBelongingsPanel caseId={found.id} action={holdBelongings} />
          )}
        </section>
      )}

      {openCase ? (
        <section aria-labelledby="close" className="flex flex-col gap-3 border-t pt-4">
          <h2 id="close" className="text-lg font-semibold">
            Close this case
          </h2>
          <CloseCasePanel
            caseId={found.id}
            action={closeAbandonmentCase}
            deceasedPrompt={DECEASED_OUTCOME_PROMPT}
          />
        </section>
      ) : (
        <section aria-labelledby="closed" className="flex flex-col gap-1 border-t pt-4">
          <h2 id="closed" className="text-lg font-semibold">
            Closed
          </h2>
          <p className="text-sm">
            {found.outcome ? ABANDONMENT_OUTCOME_LABELS[found.outcome] : 'Closed'} —{' '}
            {found.outcomeNote}
          </p>
        </section>
      )}
    </div>
  )
}
