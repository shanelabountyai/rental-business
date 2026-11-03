'use server'

import { revalidatePath } from 'next/cache'
import { after } from 'next/server'
import { audit } from '@/lib/audit/index.ts'
import { requirePermission } from '@/lib/auth/guard.ts'
import { verifyStaffStepUp } from '@/lib/auth/staff-step-up.ts'
import { claimOrgExport, runOrgExport } from '@/lib/export/org-export.ts'

export interface OrgExportFormState {
  error?: string
  notice?: string
  fieldErrors?: Record<string, string>
}

/**
 * Starts the full organisation export (R-299, PRD 10 §8). Owner-only:
 * `report.financial`, and the owner pair support access uses (`staff.manage`
 * + `audit.read`, portfolio-wide), which a manager and a support session
 * never hold. The fresh MFA is a code at the press (D-380,
 * `verifyStaffStepUp`). Returns rather than redirects (D-379).
 *
 * The work runs in `after()`, so the press answers at once and the page
 * shows the run's state; a run its function killed goes stale and the next
 * press takes it back (`claimOrgExport`).
 */
export async function startOrgExport(_previous: OrgExportFormState, formData: FormData): Promise<OrgExportFormState> {
  const actor = await requirePermission('report.financial')
  await requirePermission('staff.manage')
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
