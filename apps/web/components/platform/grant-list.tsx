import { durationLabel, supportGrantStatus } from '@rental/core/rbac'
import { friendlyTimestamp } from '@rental/core/scheduling'
import { EndGrantButton } from '@/components/platform/support-access.tsx'
import { endSupportGrant } from '@/lib/platform/support-actions.ts'

// The console's list of support grants (PRD 11 §4.7, R-295a). A server
// component: the console reads grants, admins' names, approvers' names and
// org names only (PLAT-03).

/// What every console grant list selects - PLAT-03's allowlist columns.
export const GRANT_LIST_SELECT = {
  id: true,
  kind: true,
  reason: true,
  requestedAt: true,
  requestedMinutes: true,
  approvedAt: true,
  deniedAt: true,
  denialNote: true,
  startsAt: true,
  expiresAt: true,
  endedAt: true,
  endedByType: true,
  ownersAcknowledgedAt: true,
  platformAdminId: true,
  platformAdmin: { select: { name: true } },
  organization: { select: { slug: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
  deniedBy: { select: { id: true, name: true } },
} as const

export type GrantRow = {
  id: string
  kind: 'REQUESTED' | 'BREAK_GLASS'
  reason: string
  requestedAt: Date
  requestedMinutes: number
  approvedAt: Date | null
  deniedAt: Date | null
  denialNote: string | null
  startsAt: Date | null
  expiresAt: Date | null
  endedAt: Date | null
  endedByType: string | null
  ownersAcknowledgedAt: Date | null
  platformAdminId: string
  platformAdmin: { name: string }
  organization: { slug: string; name: string }
  approvedBy: { name: string } | null
  deniedBy: { name: string } | null
}

const STATUS_WORDS = { pending: 'Waiting for an owner', live: 'Live', denied: 'Denied', ended: 'Ended', expired: 'Expired' }
const ENDED_BY: Record<string, string> = { PLATFORM: 'by support', STAFF: 'by an owner', SYSTEM: 'when the admin was deactivated', EXPIRY: 'on expiry' }

export function GrantList({ grants, viewerId, now }: { grants: GrantRow[]; viewerId: string; now: Date }) {
  if (grants.length === 0) return <p>None.</p>
  return (
    <ul className="flex flex-col gap-3">
      {grants.map((g) => {
        const status = supportGrantStatus(g, now)
        const mine = g.platformAdminId === viewerId
        return (
          <li key={g.id} className="flex flex-col gap-1 rounded-md border p-3 break-words">
            <span className="font-medium">
              {g.organization.name} · {g.kind === 'BREAK_GLASS' ? 'Emergency access' : `Request, ${durationLabel(g.requestedMinutes)}`} ·{' '}
              {STATUS_WORDS[status]}
            </span>
            <span>
              {g.platformAdmin.name} · asked {friendlyTimestamp(g.requestedAt, 'UTC')}
            </span>
            <span>Reason: {g.reason}</span>
            {g.approvedBy && g.approvedAt && (
              <span>
                Approved by {g.approvedBy.name} {friendlyTimestamp(g.approvedAt, 'UTC')}
              </span>
            )}
            {g.deniedBy && (
              <span>
                Denied by {g.deniedBy.name}
                {g.denialNote ? `: ${g.denialNote}` : ''}
              </span>
            )}
            {g.expiresAt && status === 'live' && <span>Ends {friendlyTimestamp(g.expiresAt, 'UTC')}</span>}
            {g.endedAt && (
              <span>
                Ended {g.endedByType ? ENDED_BY[g.endedByType] : ''} {friendlyTimestamp(g.endedAt, 'UTC')}
              </span>
            )}
            {mine && (status === 'live' || status === 'pending') && (
              <EndGrantButton
                action={endSupportGrant}
                grantId={g.id}
                label={status === 'pending' ? `Withdraw request to ${g.organization.name}` : `End access to ${g.organization.name} now`}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}
