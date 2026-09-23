import type { Actor } from '@rental/core/rbac'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// No request here, so no cookie: the selection falls back to "all".
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}))

const { currentScope } = await import('./current-scope.ts')

// SEC-03: a write action checks its record against the scope it builds. Built
// from `property.read`, a manager with write on A and read on B could write on B.

let entityId: string
let propA: string
let propB: string

beforeAll(async () => {
  const stamp = `sec03-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: `${stamp}-Entity`, type: 'LLC' } })
  entityId = entity.id
  const makeProperty = async (name: string) =>
    (
      await prisma.property.create({
        data: {
          legalEntityId: entityId,
          name: `${stamp}-${name}`,
          addressLine1: '1 Test St',
          city: 'Houston',
          state: 'TX',
          postalCode: '77002',
          timezone: 'America/Chicago',
          propertyType: 'SINGLE_FAMILY',
        },
      })
    ).id
  propA = await makeProperty('A')
  propB = await makeProperty('B')
})

afterAll(async () => {
  await prisma.property.deleteMany({ where: { legalEntityId: entityId } })
  await prisma.legalEntity.delete({ where: { id: entityId } })
})

function writerOnAReaderOnB(): Actor {
  return {
    id: 'staff_sec03',
    kind: 'staff',
    active: true,
    mfaVerified: true,
    assignments: [
      {
        roleKey: 'property_manager',
        permissions: ['property.read', 'property.write', 'vendor.write', 'ledger.adjust'],
        propertyId: propA,
        legalEntityId: null,
      },
      { roleKey: 'read_only', permissions: ['property.read'], propertyId: propB, legalEntityId: null },
    ],
    leaseIds: [],
    ceilings: { approveWorkOrderCents: 0, waiveFeeCents: 0 },
  }
}

describe('currentScope (SEC-03)', () => {
  const ids = (scope: { availableProperties: { id: string }[] }) =>
    scope.availableProperties.map((p) => p.id).filter((id) => id === propA || id === propB)

  it('shows both houses to read', async () => {
    expect(ids(await currentScope(writerOnAReaderOnB())).sort()).toEqual([propA, propB].sort())
  })

  it.each(['property.write', 'vendor.write', 'ledger.adjust'] as const)(
    'offers only the house the actor may write under %s',
    async (permission) => {
      const scope = await currentScope(writerOnAReaderOnB(), permission)
      expect(ids(scope)).toEqual([propA])
      expect(scope.propertyIds).not.toContain(propB)
    },
  )
})
