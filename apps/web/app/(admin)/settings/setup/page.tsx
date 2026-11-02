import { prisma } from '@rental/db'
import { PageHeader } from '@/components/page-header.tsx'
import { ChecklistSteps } from '@/components/setup/checklist.tsx'
import { SetupMarks } from '@/components/setup/setup-marks.tsx'
import { SetupTestActions } from '@/components/setup/test-actions.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { refreshOrgHealth } from '@/lib/cron/org-health.ts'
import { billTestDollar, markSetupStep, sendTestText } from '@/lib/setup/actions.ts'
import { SETUP_STEPS, setupChecklist, setupFacts, stepReason } from '@/lib/setup/checklist.ts'

export const metadata = { title: 'Setup' }
export const dynamic = 'force-dynamic'

// PRD 10 §5 (R-291a): the provisioning checklist, the owner's first screen
// until the platform marks the org live, then a settings page. Every step is
// derived from facts on each load; the load also refreshes the console's copy
// in OrgHealth, so the platform sees what the owner just did. Owner-only.
export default async function SetupPage() {
  const actor = await requirePermission('staff.manage')
  const facts = await setupFacts(actor.orgId)
  const checklist = setupChecklist(facts)
  await refreshOrgHealth(actor.orgId)
  const [{ name }, me] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: actor.orgId }, select: { name: true } }),
    prisma.staffUser.findUniqueOrThrow({ where: { id: actor.id }, select: { phone: true } }),
  ])
  const reasons = Object.fromEntries(SETUP_STEPS.map((step) => [step, stepReason(step, facts, checklist)]))

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Setup">
        <p className="text-muted-foreground text-sm break-words">
          {facts.status === 'ACTIVE'
            ? `${name} is live. This page stays as a record of each step.`
            : `${name} is being set up. The platform marks it live once every step is done.`}
        </p>
      </PageHeader>
      <ChecklistSteps
        checklist={checklist}
        reasons={reasons}
        links={{
          users: { href: '/staff', label: 'Staff and roles' },
          properties: { href: '/properties', label: 'Properties' },
          templates: { href: '/messages/templates', label: 'Message templates' },
          stripe: { href: '/money/stripe', label: 'Stripe account' },
          jurisdiction: { href: '/jurisdiction', label: 'Jurisdiction rules' },
        }}
      />
      <SetupMarks action={markSetupStep} marks={facts.marks} />
      {!checklist.test && <SetupTestActions sendText={sendTestText} billDollar={billTestDollar} phone={me.phone} />}
    </div>
  )
}
