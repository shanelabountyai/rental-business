import { prisma } from '@rental/db'

// PLAT-03 controls. Each but `allowed` must be flagged.
export async function allowed() {
  await prisma.organization.findMany({ select: { name: true, integrations: { select: { status: true } } } })
}

export async function nestedProperty() {
  await prisma.organization.findMany({ include: { properties: true } })
}

export async function everyIntegrationColumn() {
  await prisma.orgIntegration.findMany()
}

export async function staffPhone() {
  await prisma.staffUser.findMany({ select: { name: true, phone: true } })
}
