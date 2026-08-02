// db:create-owner - the bootstrap that gives a brand-new deployment its first
// human (D-5, scoped to R-007).
//
//   npm run db:create-owner -- --email you@example.com --name "Your Name"
//
// D-5: "No permission bypass. The `owner` role with an all-properties
// assignment is the only super user." So this script does not create a
// superuser - there is no such thing. It creates an ordinary StaffUser and an
// ordinary StaffAssignment with roleKey=owner and a null scope, which is
// grantable, revocable, and visible in the audit log like any other grant.
//
// It refuses to create a second owner without --force. Not because a second
// owner is wrong - a two-person business wants two - but because running a
// bootstrap script twice by accident is how a deployment quietly acquires an
// owner nobody remembers creating.

import { randomBytes } from 'node:crypto'
import { recordAudit } from '../../core/audit/index.ts'
import { hashPassword, mintToken } from '../../core/auth/index.ts'
import { prisma } from '../index.ts'

interface Args {
  email: string
  name: string
  force: boolean
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }

  const email = get('--email')?.trim().toLowerCase()
  const name = get('--name')?.trim()

  if (!email || !name) {
    console.error(
      'Usage: npm run db:create-owner -- --email <address> --name "<full name>" [--force]',
    )
    process.exit(1)
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error(`"${email}" does not look like an email address.`)
    process.exit(1)
  }

  return { email, name, force: argv.includes('--force') }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const ownerRole = await prisma.role.findUnique({ where: { key: 'owner' } })
  if (!ownerRole) {
    console.error(
      'The `owner` role does not exist. Run `npm run db:seed` first - roles are data (D-5).',
    )
    process.exit(1)
  }

  const existingOwners = await prisma.staffAssignment.count({
    where: { roleId: ownerRole.id, revokedAt: null },
  })
  if (existingOwners > 0 && !args.force) {
    console.error(
      `This deployment already has ${existingOwners} owner assignment(s).\n` +
        'Re-run with --force if you genuinely mean to add another. Granting\n' +
        'access to an existing person is better done in the app, where it is\n' +
        'audited against the granting staff member rather than against a script.',
    )
    process.exit(1)
  }

  const existing = await prisma.staffUser.findUnique({
    where: { email: args.email },
  })
  if (existing) {
    console.error(
      `A staff user already exists for ${args.email}. This script bootstraps a\n` +
        'NEW deployment; grant an existing user the owner role in the app instead.',
    )
    process.exit(1)
  }

  // A random password nobody will ever hold, so the account is never in a
  // "no credential" state and the ordinary reset flow works unchanged. It is
  // not printed anywhere - the setup link below is the only way in.
  const unusablePassword = randomBytes(32).toString('base64url')
  const setup = mintToken('STAFF_PASSWORD_RESET')

  const staffUser = await prisma.$transaction(async (tx) => {
    const created = await tx.staffUser.create({
      data: {
        email: args.email,
        name: args.name,
        credential: { create: { passwordHash: await hashPassword(unusablePassword) } },
      },
    })

    // The whole point: a null scope on an ordinary assignment row.
    await tx.staffAssignment.create({
      data: { staffUserId: created.id, roleId: ownerRole.id },
    })

    await tx.authToken.create({
      data: {
        purpose: 'STAFF_PASSWORD_RESET',
        tokenHash: setup.tokenHash,
        subjectType: 'StaffUser',
        subjectId: created.id,
        expiresAt: setup.expiresAt,
      },
    })

    // Attributed to the script, because there is nobody signed in - this is
    // the one grant in the system with no human grantor, and the audit trail
    // should say so plainly rather than pretend otherwise.
    await recordAudit(tx, {
      actor: { type: 'SYSTEM', ref: 'db:create-owner' },
      action: 'staff.assignment_granted',
      entityType: 'StaffUser',
      entityId: created.id,
      after: {
        roleKey: 'owner',
        scope: 'all properties',
        bootstrapped: true,
        forced: args.force,
      },
    })

    return created
  })

  const baseUrl = process.env.AUTH_URL ?? 'http://localhost:3000'
  const minutes = Math.round((setup.expiresAt.getTime() - Date.now()) / 60_000)

  console.info(
    [
      '',
      `Created owner: ${staffUser.name} <${staffUser.email}>`,
      'Role: owner, scoped to all properties (an ordinary assignment row - D-5).',
      '',
      'Single-use setup link - open it to set a password:',
      `  ${new URL(`/reset-password?token=${setup.token}`, baseUrl)}`,
      '',
      `It expires in ${minutes} minutes and works once. Re-run this script if it lapses.`,
      'Set up two-factor authentication straight after; every privileged action',
      'requires it (ROLE-05).',
      '',
    ].join('\n'),
  )
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
