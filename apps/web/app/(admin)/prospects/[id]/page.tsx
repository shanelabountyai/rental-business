import { notFound } from 'next/navigation'
import Link from 'next/link'
import { InviteToApplyForm } from '@/components/applications/invite-to-apply-form.tsx'
import { ProspectStageForm } from '@/components/prospects/prospect-stage-form.tsx'
import { inviteToApply } from '@/lib/applications/staff-actions.ts'
import { applicationForProspect } from '@/lib/applications/queries.ts'
import { requireScope } from '@/lib/auth/guard.ts'
import { advanceProspectStage } from '@/lib/prospects/staff-actions.ts'
import { prospectForWrite } from '@/lib/prospects/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Prospect — Rental Operations' }

const STATUS_LABELS: Record<string, string> = {
  INQUIRY: 'Inquiry',
  PRE_SCREENED: 'Pre-screened',
  SHOWING: 'Showing',
  APPLIED: 'Applied',
  SCREENED: 'Screened',
  APPROVED: 'Approved',
  SIGNED: 'Signed',
}

const INCOME_RANGE_LABELS: Record<string, string> = {
  UNDER_3000: 'Under $3,000/mo',
  RANGE_3000_5000: '$3,000–$5,000/mo',
  RANGE_5000_8000: '$5,000–$8,000/mo',
  OVER_8000: 'Over $8,000/mo',
}

export default async function ProspectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { actor } = await requireScope('lease.read')
  const scope = await currentScope(actor)

  const prospect = await prospectForWrite(id, scope)
  if (!prospect) notFound()

  const answered = prospect.preScreenRespondedAt != null
  const application = await applicationForProspect(id, scope)

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/prospects"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Prospects
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {prospect.firstName} {prospect.lastName}
        </h1>
        <p className="text-muted-foreground text-sm">
          {STATUS_LABELS[prospect.status] ?? prospect.status} · from {prospect.source}
        </p>
      </header>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <dt className="text-muted-foreground">Email</dt>
        <dd className="col-span-1 sm:col-span-2">{prospect.email ?? '—'}</dd>
        <dt className="text-muted-foreground">Phone</dt>
        <dd className="col-span-1 sm:col-span-2">{prospect.phone ?? '—'}</dd>
        {prospect.message && (
          <>
            <dt className="text-muted-foreground">Message</dt>
            <dd className="col-span-1 sm:col-span-2">{prospect.message}</dd>
          </>
        )}
      </dl>

      <section aria-labelledby="prescreen" className="flex flex-col gap-2 rounded-md border p-4">
        <h2 id="prescreen" className="text-sm font-semibold">
          Pre-screening
        </h2>
        {!answered ? (
          prospect.preScreenSentAt ? (
            <p className="text-muted-foreground text-sm">
              Sent {prospect.preScreenSentAt.toISOString().slice(0, 10)} - no answer yet.
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">Not sent yet.</p>
          )
        ) : (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Move date</dt>
            <dd>{prospect.moveDate?.toISOString().slice(0, 10) ?? '—'}</dd>
            <dt className="text-muted-foreground">Occupants</dt>
            <dd>{prospect.occupants ?? '—'}</dd>
            <dt className="text-muted-foreground">Pets</dt>
            <dd>{prospect.petsDescription || 'None mentioned'}</dd>
            <dt className="text-muted-foreground">Income range</dt>
            <dd>
              {prospect.incomeRange
                ? (INCOME_RANGE_LABELS[prospect.incomeRange] ?? prospect.incomeRange)
                : '—'}
            </dd>
            <dt className="text-muted-foreground">Prior evictions</dt>
            <dd>
              {prospect.priorEvictions == null
                ? '—'
                : prospect.priorEvictions
                  ? `Yes — ${prospect.priorEvictionsDetail ?? ''}`
                  : 'No'}
            </dd>
          </dl>
        )}
      </section>

      {answered && (
        <section aria-labelledby="application" className="flex flex-col gap-3 rounded-md border p-4">
          <h2 id="application" className="text-sm font-semibold">
            Application
          </h2>
          {!application ? (
            <>
              <p className="text-muted-foreground text-sm">Not invited to apply yet.</p>
              <InviteToApplyForm action={inviteToApply.bind(null, prospect.id)} />
            </>
          ) : (
            <>
              <p className="text-muted-foreground text-sm">
                {application.completedAt
                  ? `Complete ${application.completedAt.toISOString().slice(0, 10)}.`
                  : 'In progress.'}
              </p>
              <ul className="flex flex-col gap-2 text-sm">
                {application.applicants.map((a) => (
                  <li key={a.id} className="rounded border p-2">
                    <span className="font-medium">
                      {a.firstName} {a.lastName}
                    </span>
                    {a.isLead ? ' (lead)' : ''}
                    {' — '}
                    {a.completedAt
                      ? 'done'
                      : a.formSubmittedAt
                        ? a.feeCents
                          ? a.feePaidAt
                            ? 'fee paid, finishing up'
                            : 'waiting on fee'
                          : 'submitted'
                        : 'in progress'}
                    {' · '}
                    {a.documentCount} document{a.documentCount === 1 ? '' : 's'}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {answered && (
        <section aria-labelledby="stage" className="flex flex-col gap-2 rounded-md border p-4">
          <h2 id="stage" className="text-sm font-semibold">
            Pipeline
          </h2>
          <p className="text-muted-foreground text-sm">
            Showing, screening and e-sign are not automated yet - this records where things
            actually stand.
          </p>
          <ProspectStageForm
            action={advanceProspectStage.bind(null, prospect.id)}
            currentStatus={prospect.status}
          />
        </section>
      )}
    </div>
  )
}
