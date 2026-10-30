import 'server-only'

import {
  SMS_MAX_LENGTH,
  SMS_SEGMENT_COST_CENTS,
  normalizePhone,
  smsLength,
} from '@rental/core/comms'
import {
  announcementSmsFooter,
  quietHoursEndAfter,
  quietHoursOf,
  withinQuietHours,
} from '@rental/core/notifications'
import { friendlyTimestamp } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { messagingSettings } from '@/lib/comms/messaging-settings.ts'
import { blockedNumbers } from '@/lib/comms/opt-out-store.ts'
import { renderForRecipient } from '@/lib/comms/templates.ts'

// The composer preview and the send's own gate (R-260, PRD 08 A1/A6/B4).
//
// ONE FUNCTION FOR BOTH. The page shows `problems` and the action refuses on
// the same list, so the preview cannot say "ready" for a send the action then
// rejects. Rendering goes through `renderForRecipient`, the path the send
// takes (see its comment).

export interface AnnouncementPreview {
  sample: { tenantName: string; subject: string | null; body: string } | null
  /// Texts that will actually go: recipients with a number not on the opt-out list.
  smsRecipients: number
  /// Worst case across recipients - a long merge value can push one over.
  maxSegments: number
  encoding: 'GSM-7' | 'UCS-2'
  estimatedCostCents: number
  /// Property-local quiet hours hold the text for these, until `quietUntil`.
  quietHeld: number
  /// Property-local, e.g. "Oct 21, 8:00 AM"; the latest across properties.
  quietUntil: string | null
  /// Reasons the send must not go. Non-empty means blocked.
  problems: string[]
  /// R-266: the line every text ends with. Counted in the segments above.
  smsFooter: string
}

export async function previewAnnouncement(
  template: Parameters<typeof renderForRecipient>[0],
  leaseIds: string[],
  orgId: string,
  now = new Date(),
): Promise<AnnouncementPreview> {
  const leases = await prisma.lease.findMany({
    where: { id: { in: leaseIds } },
    select: {
      id: true,
      property: { select: { timezone: true, quietHoursStart: true, quietHoursEnd: true } },
      leaseTenants: {
        select: {
          tenant: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              preferredLocale: true,
              active: true,
            },
          },
        },
      },
    },
  })
  const rows = leases.flatMap((lease) => {
    const tenant = lease.leaseTenants.map((lt) => lt.tenant).find((t) => t.active)
    return tenant ? [{ lease, tenant }] : []
  })
  const blocked = await blockedNumbers(orgId, rows.map((r) => r.tenant.phone))
  const smsFooter = announcementSmsFooter((await messagingSettings(orgId)).businessName)

  const preview: AnnouncementPreview = {
    sample: null,
    smsRecipients: 0,
    maxSegments: 0,
    encoding: 'GSM-7',
    estimatedCostCents: 0,
    quietHeld: 0,
    quietUntil: null,
    problems: [],
    smsFooter,
  }
  const empty = new Map<string, string[]>()
  const tooLong: string[] = []
  let latest: Date | null = null

  for (const { lease, tenant } of rows) {
    const tenantName = `${tenant.firstName} ${tenant.lastName}`
    const rendered = await renderForRecipient(template, {
      tenantId: tenant.id,
      leaseId: lease.id,
      tenantName,
      preferredLocale: tenant.preferredLocale,
      email: tenant.email,
      phone: tenant.phone,
    })
    if (!rendered) continue
    preview.sample ??= { tenantName, subject: rendered.subject, body: rendered.body }
    if (rendered.missing.length > 0) empty.set(tenantName, rendered.missing)
    // The text, footer included (the same join `announcementTemplate` makes).
    const sms = `${rendered.body}\n${smsFooter}`
    if (sms.length > SMS_MAX_LENGTH) tooLong.push(tenantName)

    const phone = tenant.phone ? normalizePhone(tenant.phone) : null
    if (phone === null || blocked.has(phone)) continue
    const length = smsLength(sms)
    preview.smsRecipients += 1
    preview.maxSegments = Math.max(preview.maxSegments, length.segments)
    preview.estimatedCostCents += length.segments * SMS_SEGMENT_COST_CENTS
    if (length.encoding === 'UCS-2') preview.encoding = 'UCS-2'
    const quiet = quietHoursOf(lease.property)
    if (withinQuietHours(now, lease.property.timezone, quiet)) {
      preview.quietHeld += 1
      const until = quietHoursEndAfter(now, lease.property.timezone, quiet)
      if (!latest || until > latest) {
        latest = until
        preview.quietUntil = friendlyTimestamp(until, lease.property.timezone)
      }
    }
  }

  for (const [name, fields] of empty) {
    preview.problems.push(`${name}: nothing to put in ${fields.join(', ')}`)
  }
  if (tooLong.length > 0) {
    preview.problems.push(
      `The message is over ${SMS_MAX_LENGTH} characters for ${tooLong.slice(0, 3).join(', ')}${tooLong.length > 3 ? ` and ${tooLong.length - 3} more` : ''}`,
    )
  }
  return preview
}
