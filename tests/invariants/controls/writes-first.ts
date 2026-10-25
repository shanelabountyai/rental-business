'use server'

import { prisma } from '@rental/db'
import { requireStaff } from '@/lib/auth/guard.ts'

// ORG-01 controls. The first writes before it guards; the second never guards.
export async function writesFirst(taskId: string) {
  await prisma.task.updateMany({ where: { id: taskId }, data: { title: 'written by a stranger' } })
  await requireStaff()
}

export async function neverGuards(taskId: string) {
  return prisma.task.findUnique({ where: { id: taskId } })
}

export async function guarded(taskId: string) {
  await requireStaff()
  return prisma.task.findUnique({ where: { id: taskId } })
}
