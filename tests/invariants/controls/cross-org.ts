'use server'

import { prisma } from '@rental/db'
import { propertyResource, requirePermission, requireStaff } from '@/lib/auth/guard.ts'

// ORG-02/03/04 and sanity controls, one known-bad shape each, and one good one.
export async function unscopedWrite(taskId: string) {
  await requireStaff()
  await prisma.task.updateMany({ where: { id: taskId }, data: { title: 'written across orgs' } })
  return {}
}

export async function unscopedSecondary(taskId: string, _previous: unknown, formData: FormData) {
  const actor = await requireStaff()
  if (!(await prisma.task.findFirst({ where: { id: taskId, orgId: actor.orgId } }))) return { error: 'No such task.' }
  const otherTaskId = String(formData.get('otherTaskId') ?? '')
  await prisma.task.updateMany({ where: { id: otherTaskId }, data: { title: 'written across orgs' } })
  return {}
}

export async function echoBeforeAuthz(taskId: string) {
  await requireStaff()
  const task = await prisma.task.findUnique({ where: { id: taskId }, include: { property: true } })
  if (!task) return { error: 'No such task.' }
  await requirePermission('task.write', propertyResource(task.property!))
  return {}
}

export async function undrivable(taskId: string, _previous: unknown, formData: FormData) {
  const actor = await requireStaff()
  if (!formData.get('note')) return { error: 'Write a note.' }
  await prisma.task.updateMany({ where: { id: taskId, orgId: actor.orgId }, data: { title: 'noted' } })
  return {}
}

export async function scoped(taskId: string) {
  const actor = await requireStaff()
  const task = await prisma.task.findFirst({ where: { id: taskId, orgId: actor.orgId } })
  if (!task) return { error: 'No such task.' }
  await prisma.task.update({ where: { id: task.id }, data: { title: 'mine' } })
  return {}
}
