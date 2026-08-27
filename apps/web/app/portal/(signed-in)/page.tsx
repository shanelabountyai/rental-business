import { friendlyBusinessDate, friendlyDate, utcToBusinessDate } from '@rental/core/scheduling'
import { formatCents } from '@rental/core/money'
import Link from 'next/link'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'
import { getTenantHome, listTenantUpdates } from '@/lib/portal/queries.ts'

export const metadata = { title: 'Your home' }

// The portal's front page (R-018).
//
// Plain language throughout, per §6.4's ≤8th-grade target and D-10's lexicon.
// The rule applied here: say the thing in the words somebody would use out
// loud. "Your rent is $1,500 a month" rather than "Monthly rent obligation:
// $1,500.00". No status enum reaches this screen - MONTH_TO_MONTH becomes
// "month to month" - and no internal identifier appears at all.

const STATUS_WORDS: Record<string, string> = {
  ACTIVE: 'Your lease is current.',
  MONTH_TO_MONTH: 'You are renting month to month.',
  ENDED: 'This lease has ended.',
  TERMINATED: 'This lease has ended.',
  PENDING_SIGNATURE: 'Your lease is waiting to be signed.',
  DRAFT: 'Your lease is being prepared.',
}

/// A date a person would say out loud: "5 August 2026". Not ISO, which reads
/// as a serial number, and not a numeric locale format, where 05/08/2026
/// means two different days either side of the Atlantic. Rendered in the
/// property's timezone (D-3).
export default async function PortalHomePage() {
  const { tenant, scope } = await requireTenantWithScope()
  const [home, updates] = await Promise.all([
    getTenantHome(scope),
    listTenantUpdates(scope),
  ])
  const timeZone = home?.property.timezone ?? 'UTC'

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-2xl font-semibold tracking-tight">
        Hello, {tenant.name.split(' ')[0]}
      </h1>

      <section aria-labelledby="your-home" className="flex flex-col gap-3">
        <h2 id="your-home" className="text-lg font-semibold">
          Your home
        </h2>
        {home ? (
          <div className="flex flex-col gap-2 rounded-md border p-4">
            <p className="font-medium">
              {home.property.addressLine1}
              {home.property.addressLine2
                ? `, ${home.property.addressLine2}`
                : ''}
            </p>
            <p className="text-muted-foreground">
              {home.property.city}, {home.property.state}{' '}
              {home.property.postalCode}
            </p>
            <p>{STATUS_WORDS[home.status] ?? 'Your lease is on file.'}</p>
            <p>
              Your rent is <strong>{formatCents(home.rentCents)} a month</strong>
              .
            </p>
            <p className="text-muted-foreground">
              {home.endsOn
                ? `Started ${friendlyBusinessDate(utcToBusinessDate(home.startsOn))}. Ends ${friendlyBusinessDate(utcToBusinessDate(home.endsOn))}.`
                : `Started ${friendlyBusinessDate(utcToBusinessDate(home.startsOn))}.`}
            </p>
          </div>
        ) : (
          <p>
            We do not have a lease on file for you yet. If that looks wrong,
            send us a message and we will sort it out.
          </p>
        )}
      </section>

      <section aria-labelledby="updates" className="flex flex-col gap-3">
        <h2 id="updates" className="text-lg font-semibold">
          Recent updates
        </h2>
        {updates.length === 0 ? (
          <p>Nothing new right now.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {updates.map((update) => (
              <li
                key={update.id}
                className="flex flex-col gap-1 rounded-md border p-4"
              >
                {update.subject && (
                  <p className="font-medium">{update.subject}</p>
                )}
                <p className="whitespace-pre-wrap">{update.body}</p>
                <p className="text-muted-foreground">
                  {friendlyDate(update.createdAt, timeZone)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="help" className="flex flex-col gap-3">
        <h2 id="help" className="text-lg font-semibold">
          Need something?
        </h2>
        <Link
          href="/portal/maintenance/new"
          className="bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-12 items-center justify-center rounded-md px-6 py-2 text-base font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Report a problem
        </Link>
        {/*
          §6.4: "every tenant flow has a staff-mediated fallback (P4 Gene is
          the acid test)." Gene does not want a portal at all. Saying so here
          is the point - nobody is funnelled through this screen to reach a
          person.
        */}
        <p>
          You can also{' '}
          <Link
            href="/portal/messages"
            className="focus-visible:ring-ring rounded-md underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
          >
            send us a message
          </Link>
          , or call or text the number on your lease — you do not have to use
          this site.
        </p>
      </section>
    </div>
  )
}
