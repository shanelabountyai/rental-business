'use server'

import { prisma } from '@rental/db'
import { requireStaff } from '@/lib/auth/guard.ts'
import { requirePlatform } from '@/lib/platform/guard.ts'

// PLAT-02 controls. Each but `guarded` and `steppedUp` must be flagged.
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
