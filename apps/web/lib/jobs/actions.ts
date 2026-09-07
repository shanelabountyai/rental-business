'use server'

import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { requirePermission } from '@/lib/auth/guard.ts'
// Side-effect import, so `SCHEDULED_JOBS` is populated before `rerunJobRun`
// looks a job type up. See registrations.ts's own header for why this file is
// the ONLY thing that may be imported for that purpose.
import '@/lib/jobs/registrations.ts'
import { rerunJobRun } from '@/lib/jobs/runner.ts'

export interface FormState {
  error?: string
  notice?: string
}

const REFUSALS: Record<string, string> = {
  not_found: 'That run no longer exists.',
  not_failed:
    'That run is not in a failed state — it either succeeded already, or it is running right now. Reload the page.',
  unknown_job:
    'Nothing in this deployment registers that job any more, so there is nothing to re-run.',
}

/**
 * Re-runs one failed scheduled job (R-174).
 *
 * `requirePermission('job.manage')` with NO resource, which permissions.ts
 * calls the correct guard rather than a bug for a portfolio-wide destination:
 * "did last night's work happen" spans every property, so there is no single
 * record to check against and a property-scoped actor cannot pass. The panel
 * this button lives on is guarded the same way.
 *
 * The refusals come back as text rather than a thrown error because every one
 * of them is an ordinary race — somebody else pressed the button first, a
 * cron tick got there — and none is a fault.
 */
export async function rerunJobAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  await requirePermission('job.manage')
  const jobRunId = String(formData.get('jobRunId') ?? '')
  if (!jobRunId) return { error: 'Which run?' }

  const result = await rerunJobRun(jobRunId)

  // Audited whether it worked or not. Re-running a nightly job is a staff act
  // with side effects on somebody's ledger and somebody's statutory clock, and
  // "who pressed it, and did it work" is the question a support conversation
  // opens with.
  await audit({
    action: 'job.rerun',
    entityType: 'JobRun',
    entityId: jobRunId,
    after: result.ok
      ? { outcome: 'succeeded' }
      : { outcome: 'refused', reason: result.reason, error: result.error ?? null },
  }).catch(() => {
    // An audit failure must not swallow the result the operator needs to see.
  })

  revalidatePath('/jobs')

  if (result.ok) return { notice: 'That run succeeded this time.' }
  if (result.reason === 'failed') {
    return { error: `It failed again: ${result.error ?? 'no error recorded'}` }
  }
  return { error: REFUSALS[result.reason] ?? 'That run could not be re-run.' }
}
