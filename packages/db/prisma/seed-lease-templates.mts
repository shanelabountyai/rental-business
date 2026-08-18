// db:seed:lease-templates - installs the placeholder lease + addenda
// templates R-063 needs before it can generate a single document (LEASE-06,
// DOC-02).
//
//   npm run db:seed:lease-templates -- --staff you@example.com
//
// NOT PART OF `seed.mts`. `DocumentTemplate.createdByStaffId` is required
// (a template's author is meaningful - who wrote this legal text - the same
// reason ScreeningCriteria's own placeholder v1 could seed as pure reference
// data in seed.mts and this cannot: that table has no author column). A
// fresh database has no StaffUser at all until `db:create-owner` runs, so
// this is its own deliberate, later step, run once by whoever deploys -
// the identical posture create-owner.mts already takes for the same
// chicken-and-egg reason.
//
// OQ-7 (07-decisions.md): the owner chose a placeholder template over
// blocking the item, the same call OQ-6 made for R-060's screening
// criteria. EVERY BODY BELOW IS UNREVIEWED - each generated document
// carries LEASE_DISCLAIMER (packages/core/leases/generation.ts) saying so
// on the page itself; this script does not duplicate that warning into the
// legal prose, which would read as a lease telling its own signer not to
// trust it.
//
// Idempotent by (documentType, addendumKey, state) - skips anything already
// present rather than creating a duplicate on a second run.

import { pathToFileURL } from 'node:url'
import { ADDENDUM_KEYS, type AddendumKey } from '../../core/leases/addenda.ts'
import { prisma } from '../index.ts'

function parseArgs(argv: string[]): { staffEmail: string } {
  const index = argv.indexOf('--staff')
  const staffEmail = index >= 0 ? argv[index + 1]?.trim().toLowerCase() : undefined
  if (!staffEmail) {
    console.error('Usage: npm run db:seed:lease-templates -- --staff <staff-email>')
    process.exit(1)
  }
  return { staffEmail }
}

export const LEASE_BODY = `RESIDENTIAL LEASE AGREEMENT

This lease is entered into between {{entity.name}} ("Landlord") and {{tenants.names}} ("Tenant", jointly and severally liable for every obligation below), for the premises at {{property.address}}, {{unit.name}} ("the Premises").

1. TERM. The lease term begins {{term.starts_on}} and ends {{term.ends_on}}.

2. RENT. Tenant agrees to pay {{rent.amount}} per month, due on day {{rent.due_day}} of each month, to Landlord or Landlord's authorized agent.

3. SECURITY DEPOSIT. Tenant has paid, or agrees to pay, a security deposit of {{deposit.amount}}, held on trust and refundable subject to applicable law and the condition of the Premises at move-out.

4. GUARANTORS. {{guarantors.names}}

5. USE OF PREMISES. The Premises shall be used solely as a private residence for Tenant and any other occupants Landlord has approved in writing.

6. PETS. {{pet.terms}}

7. MAINTENANCE. Tenant shall keep the Premises in a clean and sanitary condition and promptly report any needed repairs to Landlord. Landlord shall maintain the Premises in a condition fit for human habitation as required by applicable law.

8. ENTRY. Landlord may enter the Premises for inspection, repair, or showing with notice as required by the jurisdiction the Premises is located in.

9. DEFAULT. Tenant's failure to pay rent when due, or breach of any other term of this lease, may result in the remedies available to Landlord under applicable law, including termination of tenancy.

10. GOVERNING LAW. This lease is governed by the laws of the state in which the Premises is located.

Prepared by {{staff.name}} on {{today}}.`

export const ADDENDUM_BODIES: Record<AddendumKey, string> = {
  LEAD_PAINT: `LEAD WARNING STATEMENT

Housing built before 1978 may contain lead-based paint. Lead from paint, paint chips, and dust can pose health hazards if not managed properly. Lead exposure is especially harmful to young children and pregnant women. Before renting pre-1978 housing, landlords must disclose the presence of known lead-based paint and/or lead-based paint hazards in the dwelling. Tenants must also receive a federally approved pamphlet on lead poisoning prevention.

Landlord has no knowledge of lead-based paint and/or lead-based paint hazards at {{property.address}}, {{unit.name}}, beyond what is stated here, and has no reports or records pertaining to lead-based paint and/or lead-based paint hazards at the Premises beyond what is stated here.

Tenant acknowledges receipt of the pamphlet "Protect Your Family from Lead in Your Home" and of this Lead Warning Statement.`,

  MOLD: `MOLD DISCLOSURE ADDENDUM

Landlord discloses the following known history of mold at {{property.address}}, {{unit.name}}: [staff to describe the recorded history before sending].

Tenant agrees to promptly notify Landlord in writing of any visible mold growth or water intrusion observed at the Premises, and to maintain adequate ventilation to reduce moisture accumulation.`,

  BEDBUG: `BED BUG DISCLOSURE ADDENDUM

Landlord discloses the following known history of bed bugs at {{property.address}}, {{unit.name}}: [staff to describe the recorded history before sending].

Tenant agrees to promptly notify Landlord in writing at the first sign of a bed bug infestation, and to cooperate with any inspection or treatment Landlord arranges.`,

  HOA_RULES: `HOA RULES ADDENDUM

The Premises at {{property.address}}, {{unit.name}} is subject to the rules, regulations, and any rental restrictions of the property's homeowners' association. Tenant agrees to comply with those rules as a condition of this lease, and understands that a violation may result in fees assessed against Landlord that Tenant agrees to reimburse.

Tenant should request a current copy of the HOA's rules and any rental cap policy from Landlord before signing.`,

  POOL: `POOL / SPA ADDENDUM

The Premises at {{property.address}}, {{unit.name}} includes a pool or spa. Tenant agrees to use the pool/spa at their own risk, to supervise any minor children and guests at all times while the pool/spa is in use, and to comply with all posted safety rules and applicable pool-safety law.

Tenant shall promptly report any observed defect in pool/spa equipment, fencing, or safety covers to Landlord.`,

  WELL_SEPTIC: `WELL / SEPTIC SYSTEM ADDENDUM

The Premises at {{property.address}}, {{unit.name}} is served by a private well and/or septic system rather than a municipal water or sewer connection. Tenant agrees to use these systems reasonably, to avoid flushing or disposing of anything that could damage the septic system, and to promptly report any sign of system failure (odor, backup, standing water) to Landlord.`,
}

async function main() {
  const { staffEmail } = parseArgs(process.argv.slice(2))

  const staff = await prisma.staffUser.findUnique({ where: { email: staffEmail } })
  if (!staff) {
    console.error(
      `No staff user found for ${staffEmail}. Run \`npm run db:create-owner\` first, or pass ` +
        'an existing staff member\'s email.',
    )
    process.exit(1)
  }

  let created = 0

  const existingLease = await prisma.documentTemplate.findFirst({
    where: { documentType: 'LEASE', addendumKey: null, state: null },
  })
  if (!existingLease) {
    await prisma.documentTemplate.create({
      data: {
        name: 'Residential lease (placeholder — unreviewed)',
        documentType: 'LEASE',
        state: null,
        body: LEASE_BODY,
        createdByStaffId: staff.id,
      },
    })
    created++
  }

  for (const key of ADDENDUM_KEYS) {
    const existing = await prisma.documentTemplate.findFirst({
      where: { documentType: 'ADDENDUM', addendumKey: key, state: null },
    })
    if (existing) continue
    await prisma.documentTemplate.create({
      data: {
        name: `${key.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())} addendum (placeholder — unreviewed)`,
        documentType: 'ADDENDUM',
        addendumKey: key,
        state: null,
        body: ADDENDUM_BODIES[key],
        createdByStaffId: staff.id,
      },
    })
    created++
  }

  console.info(
    created > 0
      ? `Created ${created} template(s). Every one is unreviewed - see each generated document's own footer disclaimer, and review before real use.`
      : 'Every lease/addendum template already exists. Nothing created.',
  )
}

// Guarded, unlike create-owner.mts's identical `main()` call - nothing
// imports that file, but this one exports LEASE_BODY/ADDENDUM_BODIES for
// seed-lease-templates.test.ts to check against the merge-field catalogue,
// and importing a module must never open a database connection as a side
// effect. `pathToFileURL`, not a bare `file://` template string - this
// repo's own path has a space in it ("rental business"), which
// `import.meta.url` percent-encodes and a hand-built URL string would not,
// so the naive comparison silently never matches and the script would do
// nothing when run directly.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
    .finally(() => prisma.$disconnect())
}
