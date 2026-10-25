'use server'

import { prisma } from '@rental/db'
import { requireStaff } from '@/lib/auth/guard.ts'

// ORG-01 controls. The first writes before it guards; the second never guards.
// A write that succeeds, inside a transaction that then rolls back: the spy
// sees it land and the shared database keeps nothing.
export async function writesFirst(taskId: string) {
  await prisma
    .$transaction(async (tx) => {
      await tx.organization.create({ data: { slug: `org-01-control-${taskId}-${Date.now()}`, name: 'control' } })
      throw new Error('rolled back')
    })
    .catch(() => {})
  await requireStaff()
}

export async function neverGuards(taskId: string) {
  return prisma.task.findUnique({ where: { id: taskId } })
}

export async function guarded(taskId: string) {
  await requireStaff()
  return prisma.task.findUnique({ where: { id: taskId } })
}
