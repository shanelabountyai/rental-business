'use server'

import { slugConfirmRefusal } from '@rental/core/rbac'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { after } from 'next/server'
import { audit } from '@/lib/audit/index.ts'
import { requirePermission } from '@/lib/auth/guard.ts'
import { verifyStaffStepUp } from '@/lib/auth/staff-step-up.ts'
import { claimOrgExport, runOrgExport } from '@/lib/export/org-export.ts'
import { freezeOrg } from '@/lib/org-lifecycle/lifecycle.ts'

export interface OrgExportFormState {
  error?: string
  notice?: string
  fieldErrors?: Record<string, string>
}

/**
 * Starts the full organisation export (R-299, PRD 10 §8). Owner-only:
 * `report.financial`, `property.export` and `audit.read`, portfolio-wide,
 * which a manager and a support session never hold - and which a FROZEN
 * org's owner still does, because leaving needs the export (D-386). The fresh MFA is a code at the press (D-380,
 * `verifyStaffStepUp`). Returns rather than redirects (D-379).
 *
 * The work runs in `after()`, so the press answers at once and the page
 * shows the run's state; a run its function killed goes stale and the next
 * press takes it back (`claimOrgExport`).
 */
export async function startOrgExport(_previous: OrgExportFormState, formData: FormData): Promise<OrgExportFormState> {
  const actor = await requirePermission('report.financial')
  await requirePermission('property.export')
  await requirePermission('audit.read')
  if (!(await verifyStaffStepUp(actor.id, String(formData.get('code') ?? '').trim()))) {
    return { error: 'That code did not work.', fieldErrors: { code: 'Enter the current code from your authenticator app.' } }
  }

  const claim = await claimOrgExport(actor.orgId)
  if (!claim.ok) {
    return {
      error:
        claim.reason === 'done'
          ? 'Today’s export is already made — download it below. You can make another tomorrow.'
          : 'An export is already being made. Reload the page in a minute.',
    }
  }
  await audit({ action: 'org.exported', entityType: 'JobRun', entityId: claim.id, orgId: actor.orgId, after: { jobRunId: claim.id } })
  after(() => runOrgExport(claim.id, actor.orgId))
  revalidatePath('/settings/export')
  return { notice: 'Your export has started. Reload this page in a minute or two to download it.' }
}

/**
 * The owner's own freeze (PRD 10 §8, PRD 11 §4.6, R-300a): the slug typed back
 * and a code at the press, the export's guard. One way: a frozen org's owner
 * holds no write, so restoring is platform support's (the panel says so).
 */
export async function freezeOwnOrganization(_previous: OrgExportFormState, formData: FormData): Promise<OrgExportFormState> {
  const actor = await requirePermission('report.financial')
  await requirePermission('property.export')
  await requirePermission('audit.read')
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: actor.orgId }, select: { slug: true } })
  const mismatch = slugConfirmRefusal(String(formData.get('confirmFreeze') ?? ''), org.slug)
  if (mismatch) return { error: mismatch, fieldErrors: { confirmFreeze: 'Does not match.' } }
  if (!(await verifyStaffStepUp(actor.id, String(formData.get('freezeCode') ?? '').trim()))) {
    return { error: 'That code did not work.', fieldErrors: { freezeCode: 'Enter the current code from your authenticator app.' } }
  }
  const outcome = await freezeOrg(actor.orgId, 'owner', null, (tx, entry) =>
    audit({ ...entry, entityType: 'Organization', entityId: actor.orgId, orgId: actor.orgId }, tx),
  )
  if (!outcome.ok) return { error: outcome.error }
  revalidatePath('/', 'layout')
  return { notice: 'Frozen. Everything can still be read and exported; nothing can be changed until platform support restores it.' }
}
