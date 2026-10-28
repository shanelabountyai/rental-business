// db:create-platform-admin - the platform console's first admin (PRD 11 §2.6,
// R-294b).
//
//   npm run db:create-platform-admin -- --email you@example.com --name "You" --target <host>/<db>
//   npm run db:create-platform-admin -- --reset-mfa --email you@example.com --target <host>/<db>
//
// The first form REFUSES once any active admin exists, with no --force: after
// the first, admins are added in the console, where a human is the actor (R-302).
// Until R-302 gives admins roles, "the last owner" is the last active admin.
//
// It checks the database it is ACTUALLY POINTED AT, not NODE_ENV, as
// refuseUnlessDemoDatabase does: never `rental_test` or `rental_ci`, whose
// fixtures own their admins, and only the `--target` the operator typed. That
// is the db:seed accident CLAUDE.md records, where `.env.local` resolved to
// the Neon dev branch and nobody meant it to.

import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { recordAudit } from '../../core/audit/index.ts'
import { hashPassword, mintToken } from '../../core/auth/index.ts'
import { prisma } from '../index.ts'

/// `<host>/<db>` of a Postgres URL, or null when it does not parse.
export function databaseTarget(url: string): string | null {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}${parsed.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

/// Why this URL may not be written, or null when it may.
export function targetRefusal(url: string, typed: string | undefined): string | null {
  const actual = databaseTarget(url)
  if (!actual) return 'DATABASE_URL is unset or does not parse.'
  if (/\/rental_(test|ci)$/.test(actual)) return `${actual} is a test database; its fixtures create their own admins.`
  if (!typed) return `--target is required. This run would write ${actual}.`
  if (typed !== actual) return `--target says ${typed}, but DATABASE_URL names ${actual}.`
  return null
}

function arg(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1]?.trim() : undefined
}

async function main() {
  const argv = process.argv.slice(2)
  const email = arg(argv, '--email')?.toLowerCase()
  const name = arg(argv, '--name')
  const resetMfa = argv.includes('--reset-mfa')

  if (!email || (!resetMfa && !name)) {
    console.error(
      'Usage: npm run db:create-platform-admin -- --email <address> --name "<full name>" --target <host>/<db>\n' +
        '       npm run db:create-platform-admin -- --reset-mfa --email <address> --target <host>/<db>',
    )
    process.exit(1)
  }
  const refusal = targetRefusal(process.env.DATABASE_URL ?? '', arg(argv, '--target'))
  if (refusal) {
    console.error(`REFUSED. ${refusal}`)
    process.exit(1)
  }
  console.info(`Writing ${databaseTarget(process.env.DATABASE_URL!)}.`)

  const platformHost = process.env.PLATFORM_HOST
  if (!platformHost) {
    console.error('PLATFORM_HOST is unset, so this deployment has no console to sign in to.')
    process.exit(1)
  }
  const actor = { type: 'PLATFORM' as const, ref: 'db:create-platform-admin' }
  const activeAdmins = await prisma.platformAdmin.findMany({ where: { active: true }, select: { id: true, email: true } })

  if (resetMfa) {
    // The console covers every other case (PADM-03); this is for the last
    // admin, who has no one to ask.
    const admin = activeAdmins.find((a) => a.email === email)
    if (!admin || activeAdmins.length !== 1) {
      console.error('Only the last active admin can be reset here. Ask another admin to reset you in the console.')
      process.exit(1)
    }
    await prisma.$transaction(async (tx) => {
      await tx.platformCredential.update({
        where: { platformAdminId: admin.id },
        data: { mfaSecret: null, mfaEnrolledAt: null, mfaRecoveryCodes: [] },
      })
      await tx.platformAdmin.update({ where: { id: admin.id }, data: { sessionsValidFrom: new Date() } })
      // Org-less and PLATFORM, named as the script (D-363): SYSTEM may not
      // write an org-less row.
      await recordAudit(tx, {
        actor,
        action: 'auth.mfa_reset',
        entityType: 'PlatformAdmin',
        entityId: admin.id,
        orgId: null,
        after: { mfaCleared: true },
      })
    })
    console.info(`MFA cleared for ${email}. Their next sign-in enrols a new device.`)
    return
  }

  if (activeAdmins.length > 0) {
    console.error(
      'A platform admin already exists. Add the next one in the console, where it is audited\n' +
        'against the admin who did it rather than against a script. There is no --force.',
    )
    process.exit(1)
  }

  // A random password nobody holds, so the account is never credential-less;
  // the setup link below is the only way in, as db:create-owner does.
  const setup = mintToken('PLATFORM_PASSWORD_SETUP')
  const admin = await prisma.$transaction(async (tx) => {
    const created = await tx.platformAdmin.create({
      data: {
        email,
        name: name!,
        credential: { create: { passwordHash: await hashPassword(randomBytes(32).toString('base64url')) } },
      },
    })
    await tx.authToken.create({
      data: {
        purpose: 'PLATFORM_PASSWORD_SETUP',
        tokenHash: setup.tokenHash,
        subjectType: 'PlatformAdmin',
        subjectId: created.id,
        expiresAt: setup.expiresAt,
      },
    })
    await recordAudit(tx, {
      actor,
      action: 'platform_admin.created',
      entityType: 'PlatformAdmin',
      entityId: created.id,
      orgId: null,
      after: { email, bootstrapped: true },
    })
    return created
  })

  // http only for *.localhost, where browsers treat http as secure; the
  // console's `__Host-` cookies need a secure origin everywhere else.
  const scheme = /(^|\.)localhost$/.test(platformHost) ? 'http' : 'https'
  const port = scheme === 'http' ? `:${process.env.PORT ?? 3100}` : ''
  console.info(
    [
      '',
      `Created platform admin: ${admin.name} <${admin.email}>`,
      '',
      'Single-use link - open it to set a password, then sign in and enrol two-factor:',
      `  ${scheme}://${platformHost}${port}/platform/set-password?token=${setup.token}`,
      '',
      `It expires in ${Math.round((setup.expiresAt.getTime() - Date.now()) / 60_000)} minutes and works once.`,
      '',
    ].join('\n'),
  )
}

// Imported by its unit test for the two pure functions above; run only as a script.
// Compared as URLs: a raw path differs from import.meta.url wherever the path
// has a space - this repo's does - and main() would silently never run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
    .finally(() => prisma.$disconnect())
}
