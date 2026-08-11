// Reference data, not demo data - the rows that must exist in every
// environment for the app to function at all. Idempotent, so it is safe to
// re-run on every deploy. Demo properties, units and tenants (R-013) are a
// separate script - demo-seed.mts, run with `npm run db:seed:demo`.

import { ROLE_DEFINITIONS } from '../../core/rbac/permissions.ts'
import { prisma } from '../index.ts'

/**
 * Roles-as-data (D-5). ROLE_DEFINITIONS in packages/core is the starting
 * point; these rows are the runtime source of truth, and `can()` reads the
 * permissions carried on an actor's assignments rather than the constant.
 *
 * Upserted by key, and the update deliberately rewrites `permissions`: a
 * permission added to the vocabulary in code has to reach the roles that
 * should hold it, or a release ships a permission nobody has. The cost is that
 * hand-edits to a system role's permission list are overwritten on the next
 * deploy - the right trade while ROLE-07 keeps a custom role builder out of
 * scope. When that changes, `system` is the flag to branch on.
 *
 * Ceilings are set only on CREATE. They are the one field an owner is expected
 * to tune per deployment (ROLE-02), and a deploy that quietly reset a
 * manager's approval limit back to the default would be a real incident.
 */
async function seedRoles() {
  for (const [key, definition] of Object.entries(ROLE_DEFINITIONS)) {
    await prisma.role.upsert({
      where: { key },
      create: {
        key,
        name: definition.name,
        description: definition.description,
        permissions: [...definition.permissions],
        defaultApproveWorkOrderCents: definition.defaultApproveWorkOrderCents,
        defaultWaiveFeeCents: definition.defaultWaiveFeeCents,
        system: true,
      },
      update: {
        name: definition.name,
        description: definition.description,
        permissions: [...definition.permissions],
      },
    })
  }

  console.info(`Seeded ${Object.keys(ROLE_DEFINITIONS).length} roles.`)
}

/**
 * Texas, statewide, version 1 (D-4). The footprint state this build targets
 * first; every other state is a real gap until it gets its own reviewed row
 * (OQ-1).
 *
 * `reviewedBy` is deliberately left null. These numbers are drawn from Texas
 * Property Code Chapter 92 and Chapter 24 as commonly understood, not from
 * an attorney's sign-off - the decisions doc is explicit that legal review
 * per config is a release gate no code check can substitute for, so the seed
 * ships un-reviewed rather than pretending otherwise. The admin list page
 * marks any rule with no `reviewedBy` as "unreviewed" for the same reason.
 *
 * find-then-create rather than upsert: Prisma's generated compound-unique
 * input for `(state, jurisdiction, version)` types `jurisdiction` as `string`,
 * not `string | null`, so a statewide row (jurisdiction null) cannot be
 * addressed through it at all - a known limitation of nullable columns inside
 * compound uniques. Re-running the seed must not silently rewrite a rule that
 * already governs real fees regardless (D-4 - "changing a rule never
 * rewrites history"), so this only ever creates; once v1 exists, correcting
 * it means adding v2 through the app, the same as any other change.
 */
async function seedJurisdictionRules() {
  const existing = await prisma.jurisdictionRule.findFirst({
    where: { state: 'TX', jurisdiction: null, version: 1 },
  })
  if (existing) {
    console.info('Jurisdiction rule already seeded (TX, statewide, v1).')
    return
  }

  await prisma.jurisdictionRule.create({
    data: {
      state: 'TX',
      jurisdiction: null,
      version: 1,
      effectiveFrom: new Date('2026-01-01'),

      // Tex. Prop. Code §92.019(a): a late fee cannot attach until rent has
      // been delinquent a full day past the due date.
      graceDays: 1,
      lateFeeType: 'PERCENT_OF_RENT',
      lateFeePercentBps: 1000, // 10% of rent.
      // §92.019(b) safe harbor for a property of 4 units or fewer - every
      // property this product targets.
      lateFeeMaxPercentBps: 1200,

      // Tex. Prop. Code Ch. 92 Subch. C: no statutory maximum deposit
      // amount, hence depositMaxBps left null. §92.103-.104: 30 days to
      // return or account for the deposit after surrender.
      depositDispositionDays: 30,
      depositEscrowRequired: false,
      depositInterestRequired: false,

      // Texas sets no statutory entry-notice-hours requirement; 24 hours is
      // common lease practice and the "reasonable notice" convention, not a
      // citation.
      entryNoticeHours: 24,
      // Tex. Prop. Code §24.005: at least 3 days' written notice to vacate
      // before filing eviction, absent a longer lease term.
      payOrQuitDays: 3,
      // Tex. Prop. Code §91.001: ending a month-to-month tenancy requires at
      // least one full rental period's notice.
      noticeToVacateDays: 30,
      rentIncreaseNoticeDays: 30,
      // Texas is not a just-cause state.
      justCauseRequired: false,

      // No statute mandates an order; rent-first is the product's own
      // default so a partial payment does not silently starve rent to pay
      // down fees first.
      paymentAllocationOrder: ['RENT', 'LATE_FEE', 'NSF_FEE', 'UTILITY', 'OTHER'],
      // PAY-02's returned-payment fee (R-039, D-4). Tex. Bus. & Com. Code
      // §3.506 caps a returned-check fee at the greater of 30 USD or the
      // amount the check was written for - the flat 30 is the operative
      // number for a rent-sized check, and core clamps to it. The fee is
      // still a lease term first: a lease that is silent charges nothing.
      nsfFeePermitted: true,
      nsfFeeMaxCents: 3_000,
      // PAY-01's card pass-through (R-037, D-4).
      //
      // Texas permits a credit-card surcharge; Tex. Bus. & Com. Code §604A.003
      // bars one on a DEBIT or stored-value card specifically. Stripe reports
      // `us_bank_account` and `card` without distinguishing debit from credit
      // at the point this product decides the fee, so a state whose rule turns
      // on that distinction cannot be honoured by this column alone. Left
      // permitted here because that is the law for the card type most tenants
      // pay with, and flagged in `notes` because it is the kind of nuance an
      // attorney review has to land on before this ships anywhere real.
      cardSurchargePermitted: true,
      // No statutory basis-point cap in Texas. The card-network rules cap a
      // surcharge at the merchant's cost of acceptance, which `cardFeeFor`
      // already satisfies by grossing up rather than marking up.
      cardSurchargeMaxBps: null,
      // No statutory cap on application fees in Texas.
      applicationFeeCapCents: null,
      rubsPermitted: true,

      citation: 'Tex. Prop. Code §§92.019, 92.103-.104, 24.005, 91.001; Tex. Bus. & Com. Code §§604A.003, 3.506',
      reviewedBy: null,
      notes:
        'Seeded defaults, not yet reviewed by an attorney - see decisions doc item 6. Entry-notice hours and rent-increase notice days reflect common practice, not a specific citation. cardSurchargePermitted does not distinguish debit from credit, which Tex. Bus. \u0026 Com. Code \u00a7604A.003 does - see the comment on that field.',
    },
  })

  console.info('Seeded 1 jurisdiction rule (TX, statewide, v1).')
}

async function main() {
  await seedRoles()
  await seedJurisdictionRules()
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
