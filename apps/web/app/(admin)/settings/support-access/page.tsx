import { approvableMinutes, can, durationLabel, supportGrantStatus } from '@rental/core/rbac'
import { friendlyTimestamp } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { PageHeader } from '@/components/page-header.tsx'
import { SupportAccessPanel } from '@/components/support/support-access.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { answerSupportAccess } from '@/lib/support/actions.ts'
import { orgTimezone } from '@/lib/support/grants.ts'

export const metadata = { title: 'Support access' }

// PRD 11 §4.14 (R-295a): who from platform support asked to view this
// organisation, what is open now, and every grant there has been. Readable
// with `audit.read` portfolio-wide; answering is an owner's (`staff.manage`
// as well), which a support session can never hold. In (admin) beside the
// other owner settings (/money/stripe, /messages/settings); the URL is the
// PRD's. "What was viewed" per grant links to /settings/audit?grant= (R-295b).

const KIND = { REQUESTED: 'request', BREAK_GLASS: 'emergency access' } as const
const STATUS = { pending: 'waiting', live: 'open', denied: 'denied', ended: 'ended', expired: 'expired' } as const
const ENDED_BY: Record<string, string> = {
  PLATFORM: 'by platform support',
  STAFF: 'by an owner',
  SYSTEM: 'when the admin was deactivated',
  EXPIRY: 'on expiry',
}

export default async function SupportAccessPage() {
  const actor = await requirePermission('audit.read')
  const canManage = can(actor, 'staff.manage').allowed
  const now = new Date()
  const [grants, zone] = await Promise.all([
    prisma.supportAccessGrant.findMany({
      where: { orgId: actor.orgId },
      select: {
        id: true,
        kind: true,
        reason: true,
        requestedAt: true,
        requestedMinutes: true,
        approvedAt: true,
        deniedAt: true,
        denialNote: true,
        expiresAt: true,
        endedAt: true,
        endedByType: true,
        platformAdmin: { select: { name: true } },
        approvedBy: { select: { name: true } },
        deniedBy: { select: { name: true } },
      },
      orderBy: { requestedAt: 'desc' },
      take: 200,
    }),
    orgTimezone(actor.orgId),
  ])
  const when = (d: Date) => friendlyTimestamp(d, zone)
  const withStatus = grants.map((g) => ({ g, status: supportGrantStatus(g, now) }))

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader title="Support access">
        <p className="text-muted-foreground text-sm">
          Platform support sees inside your organisation only under a grant you can see here: a request an owner
          approved, or emergency access every owner is told about at once. Either is read-only.
        </p>
      </PageHeader>
      <SupportAccessPanel
        action={answerSupportAccess}
        canManage={canManage}
        pending={withStatus
          .filter((x) => x.status === 'pending')
          .map(({ g }) => ({
            id: g.id,
            adminName: g.platformAdmin.name,
            reason: g.reason,
            requestedLabel: when(g.requestedAt),
            durationLabel: durationLabel(g.requestedMinutes),
            approvable: approvableMinutes(g.requestedMinutes).map((m) => ({ value: String(m), label: durationLabel(m) })),
          }))}
        live={withStatus
          .filter((x) => x.status === 'live')
          .map(({ g }) => ({ id: g.id, adminName: g.platformAdmin.name, kindLabel: KIND[g.kind], endsLabel: when(g.expiresAt!) }))}
        history={withStatus
          .filter((x) => x.status !== 'pending' && x.status !== 'live')
          .map(({ g, status }) => ({
            id: g.id,
            adminName: g.platformAdmin.name,
            kindLabel: KIND[g.kind],
            statusLabel: STATUS[status],
            reason: g.reason,
            requestedLabel: when(g.requestedAt),
            detail: [
              g.approvedBy && g.approvedAt ? `Approved by ${g.approvedBy.name} ${when(g.approvedAt)}.` : null,
              g.deniedBy && g.deniedAt ? `Denied by ${g.deniedBy.name} ${when(g.deniedAt)}${g.denialNote ? `: ${g.denialNote}` : ''}.` : null,
              g.endedAt ? `Ended ${g.endedByType ? ENDED_BY[g.endedByType] : ''} ${when(g.endedAt)}.` : null,
            ]
              .filter(Boolean)
              .join(' ') || null,
          }))}
      />
    </div>
  )
}
