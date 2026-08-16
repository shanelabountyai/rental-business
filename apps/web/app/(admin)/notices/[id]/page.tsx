import {
  SERVICE_METHOD_LABELS,
  noticeTypeLabel,
  serviceMethodsFor,
  serviceStandingLabel,
} from '@rental/core/notices'
import { friendlyDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ServeForm } from '@/components/notices/serve-form.tsx'
import { actorCan, requireScope } from '@/lib/auth/guard.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import { generateNoticePdfAction, recordNoticeService } from '@/lib/notices/actions.ts'
import { getNotice } from '@/lib/notices/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Notice — Rental Operations' }

// One notice, its archived PDF, and every service event against it
// (COMM-02, R-051).
//
// NO `loading.tsx` HERE OR ABOVE (R-099): this page calls notFound() for a
// record outside scope, and a Suspense boundary above would stream a 200
// before it ran — turning a deliberate 404 into a 200 that only looks right.

export default async function NoticePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { actor } = await requireScope('notice.read')
  const scope = await currentScope(actor)
  const notice = await getNotice(id, scope)
  if (!notice) notFound()

  const canSend = await actorCan('notice.send', {
    propertyId: notice.propertyId,
    legalEntityId: undefined,
  })

  const rule = await rulesFor(
    { state: notice.property.state, county: notice.property.county },
    new Date(),
  ).catch(() => null)
  const permittedMethods = serviceMethodsFor(rule, notice.type)

  const tenants = notice.lease.leaseTenants.map(
    (lt) => `${lt.tenant.firstName} ${lt.tenant.lastName}`,
  )

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/notices"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Notices
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {noticeTypeLabel(notice.type)}
        </h1>
        <p className="text-muted-foreground text-sm">
          {notice.property.name}
          {notice.lease.unit ? ` — ${notice.lease.unit.name}` : ''} ·{' '}
          {tenants.length > 0 ? tenants.join(', ') : 'No tenant on file'} · generated{' '}
          {friendlyDate(notice.generatedAt, notice.property.timezone)}
        </p>
      </header>

      <section aria-labelledby="artifact" className="flex flex-col gap-3">
        <h2 id="artifact" className="text-lg font-semibold">
          The notice
        </h2>
        {notice.document ? (
          <p className="text-sm">
            {/* A real link, not a button with a handler: the response IS a
                file, and onClick is inert until hydration. */}
            <a
              href={`/api/documents/${notice.document.id}/file`}
              className="underline underline-offset-4"
            >
              {notice.document.fileName}
            </a>{' '}
            <span className="text-muted-foreground">
              — archived. This is the exact file that was served.
            </span>
          </p>
        ) : canSend ? (
          <form action={generateNoticePdfAction.bind(null, notice.id)}>
            <button
              type="submit"
              className="border-input hover:bg-accent focus-visible:ring-ring min-h-11 rounded-md border px-4 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
            >
              Generate the PDF
            </button>
            <p className="text-muted-foreground mt-1 text-xs">
              Generated once and kept. Re-rendering later would produce a
              different file for the same served notice.
            </p>
          </form>
        ) : (
          <p className="text-muted-foreground text-sm">No PDF has been generated yet.</p>
        )}

        {notice.bodyText && (
          <pre className="bg-muted/50 overflow-x-auto rounded-md border p-3 text-sm whitespace-pre-wrap">
            {notice.bodyText}
          </pre>
        )}
      </section>

      <section aria-labelledby="service" className="flex flex-col gap-3">
        <h2 id="service" className="text-lg font-semibold">
          Service
        </h2>
        {notice.deliveries.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Not served yet. Nothing below this line is evidence until it is.
          </p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {notice.deliveries.map((delivery) => (
              <li key={delivery.id} className="flex flex-col gap-1 px-4 py-3">
                <span className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {SERVICE_METHOD_LABELS[delivery.method] ?? delivery.method}
                  </span>
                  <span className="text-muted-foreground text-sm tabular-nums">
                    {friendlyDate(delivery.servedAt, notice.property.timezone)}
                  </span>
                </span>
                <span className="text-muted-foreground text-sm">
                  {delivery.servedBy ? `Recorded by ${delivery.servedBy.name}` : 'Recorded by the system'}
                  {delivery.trackingNumber && ` · ${delivery.carrier ?? 'Tracking'} ${delivery.trackingNumber}`}
                </span>
                {delivery.proofDocument && (
                  <span className="text-sm">
                    <a
                      href={`/api/documents/${delivery.proofDocument.id}/file`}
                      className="underline underline-offset-4"
                    >
                      Proof: {delivery.proofDocument.fileName}
                    </a>
                    {delivery.proofDocument.capturedAt && (
                      <span className="text-muted-foreground">
                        {' '}
                        — photographed{' '}
                        {friendlyDate(delivery.proofDocument.capturedAt, notice.property.timezone)}
                      </span>
                    )}
                  </span>
                )}
                {delivery.method === 'PORTAL' && (
                  <span className="text-sm">
                    {delivery.readAt ? (
                      <span className="text-green-800 dark:text-green-300">
                        Read by the tenant{' '}
                        {friendlyDate(delivery.readAt, notice.property.timezone)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        Not opened yet — portal service has no proof of delivery until
                        it is.
                      </span>
                    )}
                  </span>
                )}
                <span
                  className={
                    delivery.permittedByJurisdiction === false
                      ? 'text-sm text-red-700 dark:text-red-400'
                      : 'text-muted-foreground text-xs'
                  }
                >
                  {serviceStandingLabel(delivery.permittedByJurisdiction)}
                </span>
                {delivery.note && (
                  <span className="text-muted-foreground text-sm">{delivery.note}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canSend && (
        <section aria-labelledby="record" className="flex flex-col gap-3">
          <h2 id="record" className="text-lg font-semibold">
            Record service
          </h2>
          <ServeForm
            // Bound server-side. A plain function cannot cross the
            // Server→Client boundary — only a 'use server' export has an
            // identity the client can call back to.
            action={recordNoticeService.bind(null, notice.id)}
            permittedMethods={permittedMethods}
            propertyTimezone={notice.property.timezone}
            alreadyServed={notice.deliveries.length > 0}
          />
        </section>
      )}
    </div>
  )
}
