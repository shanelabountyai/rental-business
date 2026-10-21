import { DEFAULT_QUIET_HOURS } from '@rental/core/notifications'
import { prisma } from '@rental/db'
import Link from 'next/link'
import { PageHeader } from '@/components/page-header.tsx'
import { MessagingSettingsForm, QuietHoursForm } from '@/components/comms/messaging-settings-forms.tsx'
import { actorCan, requireScope } from '@/lib/auth/guard.ts'
import { propertyWhere } from '@/lib/auth/scope.ts'
import { saveMessagingSettings, saveQuietHours } from '@/lib/comms/messaging-settings-actions.ts'

export const metadata = { title: 'Messaging settings — Rental Operations' }

// R-266 (PRD 08 B5, M2.2, M2.3). requireScope, not a bare requirePermission:
// a property-scoped manager with `template.write` sets their own properties'
// quiet hours; only a portfolio-wide grant sees the portfolio form. The
// sender number is not here; it is per organisation and belongs to R-275.

function hourLabel(hour: number): string {
  if (hour === 0) return '12 AM (midnight)'
  if (hour === 12) return '12 PM (noon)'
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`
}

const HOURS = [
  {
    value: 'default',
    label: `Default (${hourLabel(DEFAULT_QUIET_HOURS.startHour)} to ${hourLabel(DEFAULT_QUIET_HOURS.endHour)})`,
  },
  ...Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), label: hourLabel(hour) })),
]

export default async function MessagingSettingsPage() {
  const { scope } = await requireScope('template.write')
  const where = propertyWhere(scope)
  const [portfolio, properties] = await Promise.all([
    actorCan('template.write'),
    where
      ? prisma.property.findMany({
          where: { ...where, active: true },
          orderBy: { name: 'asc' },
          select: { id: true, name: true, quietHoursStart: true, quietHoursEnd: true },
        })
      : [],
  ])
  const [settings, staff] = portfolio
    ? await Promise.all([
        prisma.messagingSettings.findUnique({ where: { id: 'default' } }),
        prisma.staffUser.findMany({
          where: {
            active: true,
            assignments: { some: { revokedAt: null, role: { permissions: { has: 'task.write' } } } },
          },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        }),
      ])
    : [null, []]

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/messages"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Messages
        </Link>
        <PageHeader title="Messaging settings" />
      </header>

      {portfolio && (
        <section aria-labelledby="portfolio-heading" className="flex flex-col gap-3 rounded-lg border p-4">
          <h2 id="portfolio-heading" className="font-medium">
            Every property
          </h2>
          <p className="text-muted-foreground text-sm">
            A tenant&rsquo;s reply goes to the person below only while they can work that
            property&rsquo;s tasks; otherwise anyone can claim it.
          </p>
          <MessagingSettingsForm
            action={saveMessagingSettings}
            businessName={settings?.businessName ?? null}
            replyTaskAssigneeStaffId={settings?.replyTaskAssigneeStaffId ?? null}
            staff={staff}
          />
        </section>
      )}

      <section aria-labelledby="quiet-heading" className="flex flex-col gap-3">
        <h2 id="quiet-heading" className="font-medium">
          Quiet hours
        </h2>
        <p className="text-muted-foreground text-sm">
          Texts and emails that would go out in these local hours wait until they end. Emergency
          maintenance messages are never held.
        </p>
        {properties.length === 0 ? (
          <p className="text-sm">No active properties.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {properties.map((property) => (
              <li key={property.id} className="flex min-w-0 flex-col gap-2 rounded-lg border p-4 break-words">
                <h3 className="text-sm font-medium">{property.name}</h3>
                <QuietHoursForm action={saveQuietHours} property={property} hours={HOURS} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
