'use server'

import { prisma } from '@rental/db'
import { requireStaff } from '@/lib/auth/guard.ts'
import { requirePlatform } from '@/lib/platform/guard.ts'

// PLAT-02 controls. Each but `guarded`, `steppedUp`, `permissioned` and
// `stepUpPermission` must be flagged.
export async function queriesFirst() {
  await prisma.platformAdmin.count()
  await requirePlatform()
}

export async function staffGuarded() {
  await requireStaff()
}

export async function noStepUp() {
  await requirePlatform()
}

export async function guarded() {
  await requirePlatform()
}

export async function steppedUp() {
  await requirePlatform({ stepUp: true, next: '/platform/account' })
}

/// Its manifest entry names a permission it never asks for.
export async function noPermission() {
  await requirePlatform()
}

export async function permissioned() {
  await requirePlatform({ permission: 'org.read' })
}

/// A step-up permission needs no `stepUp: true` beside it (§3.1).
export async function stepUpPermission() {
  await requirePlatform({ permission: 'platformAdmin.manage', next: '/platform/admins' })
}
