'use server'

import { prisma } from '@rental/db'
import { requirePermission, requireStaff } from '@/lib/auth/guard.ts'

// PLAT-06 controls (R-295b). The first writes behind the staff floor alone,
// which a support session passes: the shape PLAT-06 exists to catch. The
// second asks for a write permission first, which support does not hold.

/// A write that lands and then rolls back, as ORG-01's controls do: the spy
/// sees it, the shared database keeps nothing.
function harmlessRow() {
  return prisma
    .$transaction(async (tx) => {
      await tx.organization.create({ data: { slug: `plat-06-control-${Date.now()}`, name: 'control' } })
      throw new Error('rolled back')
    })
    .catch(() => {})
}

export async function writesBehindStaffFloor() {
  await requireStaff()
  await harmlessRow()
}

export async function writesBehindWritePermission() {
  await requirePermission('lease.write')
  await harmlessRow()
}
