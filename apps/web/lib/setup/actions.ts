'use server'

import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { requirePermission } from '@/lib/auth/guard.ts'
import { refreshOrgHealth } from '@/lib/cron/org-health.ts'
import { SETUP_MARKS, type SetupMark } from '@/lib/setup/checklist.ts'

// The owner's three statements on /settings/setup (PRD 10 §5, R-291a): "just
// me", templates reviewed, the shared email domain. Owner-only (`staff.manage`,
// portfolio-wide). Returns rather than redirects, like every org-host action
// since D-379.

export interface SetupFormState {
  error?: string
  notice?: string
}

const NOTICE: Record<SetupMark, [string, string]> = {
  just_me: ['Marked: you run this organisation alone.', 'Unmarked: invite a member to finish this step.'],
  templates_reviewed: ['Marked: message templates reviewed.', 'Unmarked: message templates not reviewed.'],
  shared_email: [
    'Marked: email goes from the shared domain under your organisation’s name.',
    'Unmarked: email waits for your own domain.',
  ],
}

export async function markSetupStep(_previous: SetupFormState, formData: FormData): Promise<SetupFormState> {
  const actor = await requirePermission('staff.manage')
  const mark = String(formData.get('mark') ?? '') as SetupMark
  if (!SETUP_MARKS.includes(mark)) return { error: 'That step is not recognised.' }
  const on = formData.get('intent') === 'on'

  const changed = await prisma.$transaction(async (tx) => {
    const { setupMarks } = await tx.organization.findUniqueOrThrow({
      where: { id: actor.orgId },
      select: { setupMarks: true },
    })
    if (setupMarks.includes(mark) === on) return false
    const after = on ? [...setupMarks, mark] : setupMarks.filter((m) => m !== mark)
    // Conditional on the marks as read, so two presses audit one change.
    const { count } = await tx.organization.updateMany({
      where: { id: actor.orgId, setupMarks: { equals: setupMarks } },
      data: { setupMarks: after },
    })
    if (count === 0) return false
    await audit(
      { action: 'org.setup_marked', entityType: 'Organization', entityId: actor.orgId, orgId: actor.orgId, after: { mark, on } },
      tx,
    )
    return true
  })
  if (!changed) return { notice: 'Nothing changed: that step was already marked that way.' }
  await refreshOrgHealth(actor.orgId)
  revalidatePath('/settings/setup')
  return { notice: NOTICE[mark][on ? 0 : 1] }
}
