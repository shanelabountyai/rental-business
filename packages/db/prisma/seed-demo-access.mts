// db:seed:demo-access - every way into the product, for a demo you can drive.
//
//   npm run db:seed:demo-access
//
// WHY THIS EXISTS AND WHY IT IS SAFE. The repo's rule is that there are no
// fixed passwords anywhere: `db:create-owner` mints a single-use setup link
// and never prints a credential, because a password in a repo is a password
// in every clone of it. That rule is right for the product and useless for a
// demo, where five roles have to be signed into in front of somebody.
//
// The global convention allows exactly this exception - "known-value demo
// credentials are fine when the seed that uses them refuses to run in
// production, and the file should say so." So: it says so, and it refuses.
// The guard below is a REFUSAL, not a warning, and it checks the database it
// is actually pointed at rather than NODE_ENV, which is unset in half the
// ways this could be run.
//
// WHAT IT CANNOT DO, and this is the product working correctly rather than a
// gap:
//   - A TENANT has no password. `auth.ts` wires one tenant provider,
//     `tenant-magic-link`, and no password provider - the
//     `TenantCredential.passwordHash` column is schema-only today. So this
//     prints magic links instead, minted the way the sign-in action mints
//     them (the same helper e2e/portal.spec.ts uses).
//   - A VENDOR has no account at all, ever (D-6). It gets a signed,
//     expiring, single-work-order link, and this prints one of those too.
// Handing either of them a password would mean building a login that does
// not exist, which is a product change and not a demo script.
//
// Re-runnable. An account that already exists has its password reset to the
// documented one rather than erroring, because the failure mode of a demo
// script is being run twice five minutes before the demo.

import { recordAudit } from '../../core/audit/index.ts'
import { refuseUnlessDemoDatabase } from './demo-database-guard.mts'
import { hashPassword, mintToken } from '../../core/auth/index.ts'
import { prisma } from '../index.ts'

/// Documented in docs/DEMO-SCRIPT.md and nowhere else that matters. 16
/// characters, over the 12-character floor in packages/core/auth/password.ts
/// and not on its blocklist.
const DEMO_PASSWORD = 'demo-rental-2026'

interface Persona {
  email: string
  name: string
  roleKey: string
  /// A property NAME rather than an id: ROLE-04's property-scoped manager is
  /// the most interesting thing RBAC does here and `db:create-owner` cannot
  /// make one (its scope is always all-properties, as its own header says).
  scopeToPropertyNamed?: string
}

const PERSONAS: Persona[] = [
  { email: 'owner@demo.test', name: 'Dana Reyes', roleKey: 'owner' },
  { email: 'manager@demo.test', name: 'Pat Morales', roleKey: 'manager' },
  { email: 'tech@demo.test', name: 'Sam Okonkwo', roleKey: 'maintenance_tech' },
  { email: 'partner@demo.test', name: 'Jo Bookkeeper', roleKey: 'read_only' },
  {
    email: 'scoped@demo.test',
    name: 'Riley Chen',
    roleKey: 'manager',
    scopeToPropertyNamed: 'Riverside Court Duplex',
  },
]

async function upsertStaff(persona: Persona, passwordHash: string) {
  const role = await prisma.role.findUnique({ where: { key: persona.roleKey } })
  if (!role) throw new Error(`No Role row for "${persona.roleKey}" - run db:seed first.`)

  let propertyId: string | null = null
  if (persona.scopeToPropertyNamed) {
    const property = await prisma.property.findFirst({
      where: { name: persona.scopeToPropertyNamed, active: true },
      select: { id: true },
    })
    if (!property) {
      throw new Error(
        `No active property named "${persona.scopeToPropertyNamed}" - run db:seed:demo first.`,
      )
    }
    propertyId = property.id
  }

  const staffUser = await prisma.$transaction(async (tx) => {
    const user = await tx.staffUser.upsert({
      where: { email: persona.email },
      // The password is reset on every run rather than left alone: an account
      // whose password somebody changed mid-demo is worse than one recreated.
      update: {
        name: persona.name,
        active: true,
        credential: {
          upsert: {
            create: { passwordHash },
            // Clearing MFA too - a demo account that demands a code from an
            // authenticator nobody in the room holds is a locked door.
            // DEMO-SCRIPT.md says how to enrol one deliberately.
            update: {
              passwordHash,
              mfaSecret: null,
              mfaEnrolledAt: null,
              mfaRecoveryCodes: [],
              failedLoginCount: 0,
              lockedUntil: null,
            },
          },
        },
      },
      create: {
        email: persona.email,
        name: persona.name,
        credential: { create: { passwordHash } },
      },
    })

    // Assignments are additive rows, and a re-run must not stack a second
    // identical grant. Revoke what this script granted before, then grant.
    await tx.staffAssignment.updateMany({
      where: { staffUserId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    await tx.staffAssignment.create({
      data: { staffUserId: user.id, roleId: role.id, propertyId },
    })

    await recordAudit(tx, {
      actor: { type: 'SYSTEM', ref: 'db:seed:demo-access' },
      action: 'staff.assignment_granted',
      entityType: 'StaffUser',
      entityId: user.id,
      after: {
        roleKey: persona.roleKey,
        scope: persona.scopeToPropertyNamed ?? 'all properties',
        demoSeeded: true,
      },
    })

    return user
  })

  return { staffUser, scope: persona.scopeToPropertyNamed ?? 'all properties' }
}

/// Mints a magic link the way the portal sign-in action does, without needing
/// email delivery. Mirrors e2e/portal.spec.ts's helper.
async function magicLinkFor(tenantId: string): Promise<string> {
  const minted = mintToken('TENANT_MAGIC_LINK')
  await prisma.authToken.create({
    data: {
      purpose: 'TENANT_MAGIC_LINK',
      tokenHash: minted.tokenHash,
      subjectType: 'Tenant',
      subjectId: tenantId,
      expiresAt: minted.expiresAt,
    },
  })
  return `/portal/verify?token=${minted.token}`
}

/// The same revoke-then-issue shape as apps/web/lib/vendors/link.ts, which
/// cannot be imported from here (apps/web is not a dependency of packages/db).
/// A work order holds at most one live link at a time, and re-running this
/// must not widen that.
async function vendorLinkFor(workOrderId: string, vendorId: string): Promise<string> {
  const minted = mintToken('VENDOR_WORK_ORDER')
  await prisma.$transaction(async (tx) => {
    await tx.authToken.updateMany({
      where: { purpose: 'VENDOR_WORK_ORDER', subjectId: workOrderId, consumedAt: null },
      data: { consumedAt: new Date() },
    })
    await tx.authToken.create({
      data: {
        purpose: 'VENDOR_WORK_ORDER',
        tokenHash: minted.tokenHash,
        subjectType: 'WorkOrder',
        subjectId: workOrderId,
        expiresAt: minted.expiresAt,
        // `metadata.vendorId`, not a column: `vendorLinkAccess()` compares it
        // against whoever the work order currently names, so a reassigned
        // vendor's un-expired link stops opening a gate code.
        metadata: { vendorId },
      },
    })
  })
  return `/vendor/${minted.token}`
}

async function main() {
  refuseUnlessDemoDatabase('writes known passwords', 'npm run db:seed:demo-access')

  const base = process.env.AUTH_URL ?? 'http://localhost:3100'
  const passwordHash = await hashPassword(DEMO_PASSWORD)
  const out: string[] = ['']

  out.push('STAFF - sign in at ' + new URL('/login', base))
  out.push(`Password for every account below: ${DEMO_PASSWORD}`)
  out.push('')
  for (const persona of PERSONAS) {
    const { staffUser, scope } = await upsertStaff(persona, passwordHash)
    out.push(`  ${staffUser.email.padEnd(20)} ${persona.roleKey.padEnd(18)} ${scope}`)
  }

  // Every ACTIVE tenancy, so the script names whoever the demo seed made
  // rather than a list that goes stale the next time the seed changes.
  const tenants = await prisma.tenant.findMany({
    where: {
      leaseTenants: {
        some: { lease: { status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] }, property: { active: true } } },
      },
    },
    select: { id: true, firstName: true, lastName: true, email: true },
    orderBy: { lastName: 'asc' },
  })

  out.push('')
  out.push('TENANTS - no password exists for a tenant (magic link only, by design).')
  out.push('Each link is single-use and short-lived; re-run this script for fresh ones.')
  out.push('')
  for (const tenant of tenants) {
    const link = await magicLinkFor(tenant.id)
    out.push(`  ${`${tenant.firstName} ${tenant.lastName}`.padEnd(18)} ${new URL(link, base)}`)
  }

  const job = await prisma.workOrder.findFirst({
    where: { vendorId: { not: null }, status: { in: ['ASSIGNED', 'SCHEDULED', 'IN_PROGRESS'] } },
    select: { id: true, scope: true, vendorId: true, vendor: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  })

  out.push('')
  out.push('VENDOR - no account exists for a vendor, ever (D-6). One scoped link per job.')
  out.push('')
  if (job?.vendorId) {
    const link = await vendorLinkFor(job.id, job.vendorId)
    out.push(`  ${job.vendor?.name ?? 'vendor'} - ${job.scope}`)
    out.push(`  ${new URL(link, base)}`)
  } else {
    out.push('  No dispatched work order in this database - run db:seed:demo first.')
  }

  out.push('')
  console.info(out.join('\n'))
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
