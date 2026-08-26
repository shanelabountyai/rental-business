import { formatCents } from '@rental/core/money'
import { prisma } from '@rental/db'
import { auth } from '@/auth.ts'
import { MfaEnrolment } from '@/components/mfa-enrolment.tsx'
import { OnCallToggle } from '@/components/maintenance/on-call-toggle.tsx'
import { NotificationPreferencesSection } from '@/components/notifications/preferences-section.tsx'
import {
  beginMfaEnrolment,
  confirmMfaEnrolment,
  signOutEverywhere,
} from '@/lib/auth/actions.ts'
import { requireStaff } from '@/lib/auth/guard.ts'
import { setOnCall } from '@/lib/oncall/actions.ts'
import { getPreferences } from '@/lib/notifications/queries.ts'
import { CalendarFeedPanel } from '@/components/account/calendar-feed-panel.tsx'
import { regenerateCalendarFeed } from '@/lib/calendar/actions.ts'

export const metadata = { title: 'Your account — Rental Operations' }

// Lives inside the admin shell (R-007). Shows the resolved permission set and
// ceilings, and owns MFA enrolment - which every privileged action depends on
// (ROLE-05), so it is reachable from the header on every screen.
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ mfa?: string }>
}) {
  const [actor, session, { mfa }] = await Promise.all([
    requireStaff(),
    auth(),
    searchParams,
  ])

  const [credential, assignments, preferences, onCall, calendarLinkCount] = await Promise.all([
    prisma.staffCredential.findUnique({
      where: { staffUserId: actor.id },
      select: { mfaEnrolledAt: true },
    }),
    prisma.staffAssignment.findMany({
      where: { staffUserId: actor.id, revokedAt: null },
      select: {
        id: true,
        role: { select: { name: true } },
        property: { select: { name: true } },
        legalEntity: { select: { name: true } },
      },
    }),
    getPreferences('STAFF', actor.id),
    prisma.staffUser.findUnique({
      where: { id: actor.id },
      select: { onCallUntil: true },
    }),
    // R-097c. Whether they hold one, never the token itself - it is hashed,
    // like every other credential in this product, so there is no reading it
    // back and the panel offers a new one instead.
    prisma.authToken.count({
      where: {
        purpose: 'CALENDAR_FEED',
        subjectId: actor.id,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
    }),
  ])
  const hasCalendarLink = calendarLinkCount > 0

  // Lapsed windows read as "not on call" here, exactly as the rota reads them
  // (packages/core/oncall) - a stale end date shown as if it were live would
  // tell somebody they are covered when nothing would page them.
  const onCallUntil =
    onCall?.onCallUntil && onCall.onCallUntil > new Date()
      ? onCall.onCallUntil.toLocaleString('en-US', {
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
        })
      : null

  const ceiling = (cents: number | null) =>
    cents === null ? 'No limit' : formatCents(cents)

  return (
    <div className="flex w-full max-w-xl flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Your account</h1>
        <p className="text-muted-foreground text-sm">
          {session?.principal.name} · {session?.principal.email}
        </p>
      </header>

      {/*
        Set by the guard when a privileged action was refused for want of a
        second factor (ROLE-05). The user IS allowed to do the thing - they
        just have not proved possession of their device yet - so the message
        says what to do rather than that they lack access.
      */}
      {mfa === 'required' && (
        <p
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          That action needs two-factor authentication. Set it up below and try
          again.
        </p>
      )}

      <section aria-labelledby="access" className="flex flex-col gap-3">
        <h2 id="access" className="text-lg font-semibold">
          Your access
        </h2>
        {assignments.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            You have no roles yet. Someone with access management needs to grant
            you one before you can do anything.
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {assignments.map((assignment) => (
              <li key={assignment.id}>
                <strong>{assignment.role.name}</strong>
                {' — '}
                {assignment.property
                  ? assignment.property.name
                  : assignment.legalEntity
                    ? `all properties of ${assignment.legalEntity.name}`
                    : 'all properties'}
              </li>
            ))}
          </ul>
        )}
        <dl className="text-muted-foreground grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt>Can approve work up to</dt>
          <dd>{ceiling(actor.ceilings.approveWorkOrderCents)}</dd>
          <dt>Can waive fees up to</dt>
          <dd>{ceiling(actor.ceilings.waiveFeeCents)}</dd>
        </dl>
      </section>

      <CalendarFeedPanel hasLink={hasCalendarLink} action={regenerateCalendarFeed} />

      <section aria-labelledby="on-call" className="flex flex-col gap-3">
        <h2 id="on-call" className="text-lg font-semibold">
          On call
        </h2>
        <OnCallToggle onCallUntil={onCallUntil} setOnCall={setOnCall} />
      </section>

      <section aria-labelledby="mfa" className="flex flex-col gap-3">
        <h2 id="mfa" className="text-lg font-semibold">
          Two-factor authentication
        </h2>
        <p className="text-muted-foreground text-sm">
          Required before you can approve spending, waive a fee, adjust a
          ledger, reveal an access code or change anyone&rsquo;s access.
        </p>
        <MfaEnrolment
          enrolled={credential?.mfaEnrolledAt != null}
          begin={beginMfaEnrolment}
          confirm={confirmMfaEnrolment}
        />
      </section>

      <NotificationPreferencesSection preferences={preferences} />

      <section aria-labelledby="sessions" className="flex flex-col gap-3">
        <h2 id="sessions" className="text-lg font-semibold">
          Sessions
        </h2>
        <form action={signOutEverywhere}>
          <button
            type="submit"
            className="border-input focus-visible:ring-ring min-h-11 rounded-md border px-4 py-2 text-base font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            Sign out of every device
          </button>
        </form>
      </section>
    </div>
  )
}
