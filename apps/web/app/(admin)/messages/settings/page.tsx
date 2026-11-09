import { type ReviewStatus, formatPhone } from '@rental/core/comms'
import { DEFAULT_QUIET_HOURS, wordedTemplates } from '@rental/core/notifications'
import { prisma } from '@rental/db'
import Link from 'next/link'
import { PageHeader } from '@/components/page-header.tsx'
import {
  MessagingSettingsForm,
  QuietHoursForm,
  TemplateWordingForm,
} from '@/components/comms/messaging-settings-forms.tsx'
import { actorCan, requireScope } from '@/lib/auth/guard.ts'
import { propertyWhere } from '@/lib/auth/scope.ts'
import {
  saveMessagingSettings,
  saveQuietHours,
  saveTemplateWording,
} from '@/lib/comms/messaging-settings-actions.ts'
import { type TextingStatus, textingStatus } from '@/lib/integrations/twilio-status.ts'

export const metadata = { title: 'Messaging settings' }

// R-266 (PRD 08 B5, M2.2, M2.3). requireScope, not a bare requirePermission:
// a property-scoped manager with `template.write` sets their own properties'
// quiet hours; only a portfolio-wide grant sees the portfolio form. The
// sender number's registration is R-273's panel below, read from Twilio.

function hourLabel(hour: number): string {
  if (hour === 0) return '12 AM (midnight)'
  if (hour === 12) return '12 PM (noon)'
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`
}

const REVIEW_LABEL: Record<ReviewStatus, string> = {
  PENDING: 'Submitted, waiting for review',
  IN_REVIEW: 'In review',
  APPROVED: 'Approved',
  FAILED: 'Rejected',
}

function TextingNumber({ status }: { status: TextingStatus }) {
  if (status.kind === 'none') {
    return <p className="text-sm">No texting number is set up, so texts to tenants are not sent.</p>
  }
  if (status.kind === 'unreachable') {
    return (
      <p className="text-sm">
        Twilio could not be reached just now, so the number&rsquo;s registration is unknown. Reload
        the page to try again.
      </p>
    )
  }
  const registration = status.kind === 'toll_free' ? 'Toll-free verification' : '10DLC campaign'
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm break-words">
      <dt className="text-muted-foreground">Number</dt>
      <dd>{status.phoneNumber ? formatPhone(status.phoneNumber) : 'None attached'}</dd>
      <dt className="text-muted-foreground">{registration}</dt>
      <dd>
        {status.status
          ? REVIEW_LABEL[status.status]
          : 'Not submitted. Carriers block or filter texts from an unregistered number.'}
        {status.reason && <span className="block">Twilio says: {status.reason}</span>}
      </dd>
    </dl>
  )
}

const HOURS = [
  {
    value: 'default',
    label: `Default (${hourLabel(DEFAULT_QUIET_HOURS.startHour)} to ${hourLabel(DEFAULT_QUIET_HOURS.endHour)})`,
  },
  ...Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), label: hourLabel(hour) })),
]

export default async function MessagingSettingsPage() {
  const { actor, scope } = await requireScope('template.write')
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
  const [settings, staff, texting] = portfolio
    ? await Promise.all([
        prisma.messagingSettings.findUnique({ where: { orgId: actor.orgId } }),
        prisma.staffUser.findMany({
          where: {
            active: true,
            // R-285b: staff who can work tasks in THIS org.
            assignments: { some: { orgId: actor.orgId, revokedAt: null, role: { permissions: { has: 'task.write' } } } },
          },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        }),
        textingStatus(actor.orgId),
      ])
    : [null, [], null]

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

      {texting && (
        <section aria-labelledby="texting-heading" className="flex flex-col gap-3 rounded-lg border p-4">
          <h2 id="texting-heading" className="font-medium">
            Texting number
          </h2>
          <TextingNumber status={texting} />
        </section>
      )}

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

      {portfolio && (
        <section aria-labelledby="wording-heading" className="flex flex-col gap-3">
          <h2 id="wording-heading" className="font-medium">
            Automated message wording
          </h2>
          <p className="text-muted-foreground text-sm">
            These emails go out on their own. You can change how they greet a tenant and how they
            end; the amounts, dates, addresses and links stay as the system writes them. Texts are
            not changed.
          </p>
          <ul className="flex flex-col gap-3">
            {wordedTemplates().map((template) => (
              <li key={template.key} className="flex min-w-0 flex-col gap-2 rounded-lg border p-4 break-words">
                <h3 className="text-sm font-medium">{template.label}</h3>
                <TemplateWordingForm
                  action={saveTemplateWording}
                  template={template}
                  saved={
                    ((settings?.templateWording ?? {}) as Record<string, { greeting?: string; closing?: string }>)[
                      template.key
                    ] ?? {}
                  }
                />
              </li>
            ))}
          </ul>
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
