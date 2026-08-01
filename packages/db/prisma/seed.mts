// Reference data, not demo data - the rows that must exist in every
// environment for the app to function at all. Idempotent, so it is safe to
// re-run on every deploy.
//
// Still to come:
//   R-010  the seeded Texas JurisdictionRule and its effective-dated siblings
//   R-013  demo properties, units and tenants for e2e (separate script)

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

async function main() {
  await seedRoles()
  console.info('No jurisdiction rules yet - see R-010.')
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
