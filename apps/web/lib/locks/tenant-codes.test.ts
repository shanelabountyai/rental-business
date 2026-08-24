import { randomUUID } from 'node:crypto'
import { openSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SimulatedSmartLockAdapter } from '@/lib/locks/simulated-adapter.ts'
import { smartLockAdapter } from '@/lib/locks/provider.ts'
import { issueTenantLockCodeFor, revokeTenantLockCodes } from './tenant-codes.ts'

// The tenant door-code lifecycle (PROP-03, LEASE-08; R-094b).
//
// EVERY ASSERTION HERE ENDS AT THE DEVICE, not at a row. R-094 established
// why: a table saying "revoked" and a door that still opens are two
// different facts, and only one of them keeps a former occupant out. So each
// test types the code at the simulated lock and reads what the lock says.

vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))

const lockAdapter = smartLockAdapter as SimulatedSmartLockAdapter

let entityId: string
let propertyId: string
let unitId: string
let lockExternalId: string
let smartLockId: string
let staffId: string
const leaseIds: string[] = []
const tenantIds: string[] = []

beforeAll(async () => {
  const stamp = `doorcode-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '5 Keypad Row',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
      yearBuilt: 2015,
    },
  })
  propertyId = property.id
  const unit = await prisma.unit.create({
    data: { propertyId, name: `${stamp}-U`, status: 'OCCUPIED' },
  })
  unitId = unit.id
  lockExternalId = `dev-${stamp}`
  const lock = await prisma.smartLock.create({
    data: { unitId, externalId: lockExternalId, label: 'Front door keypad' },
  })
  smartLockId = lock.id
  const staff = await prisma.staffUser.create({
    data: { email: `${stamp}@example.test`, name: 'Door Code Staff' },
  })
  staffId = staff.id
})

afterAll(async () => {
  await prisma.tenantLockCode.deleteMany({ where: { smartLockId } })
  await prisma.leaseTenant.deleteMany({ where: { leaseId: { in: leaseIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.smartLock.deleteMany({ where: { id: smartLockId } })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.unit.deleteMany({ where: { id: unitId } })
  await prisma.staffUser.updateMany({ where: { id: staffId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

async function tenancy(names: readonly string[]) {
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01T00:00:00Z'),
      rentCents: 150_000,
      depositCents: 0,
    },
  })
  leaseIds.push(lease.id)
  const people = []
  for (const [index, name] of names.entries()) {
    const tenant = await prisma.tenant.create({
      data: {
        firstName: name,
        lastName: `Door-${randomUUID().slice(0, 6)}`,
        email: `${randomUUID().slice(0, 8)}@example.test`,
      },
    })
    tenantIds.push(tenant.id)
    await prisma.leaseTenant.create({
      data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: index === 0 },
    })
    people.push(tenant)
  }
  return { lease, people }
}

async function issue(leaseId: string, tenantId: string) {
  const result = await issueTenantLockCodeFor({ leaseId, tenantId, staffId })
  if (result.refusal) throw new Error(`unexpected refusal: ${result.refusal}`)
  return result.issued
}

const opens = (code: string) =>
  lockAdapter.simulateEntry({ externalId: lockExternalId, code, at: new Date() }).kind === 'UNLOCKED'

describe('issuing', () => {
  it('programs the door, and the code it hands back is the code the door takes', async () => {
    const { lease, people } = await tenancy(['Ada'])
    const issued = await issue(lease.id, people[0]!.id)
    expect(opens(issued.code)).toBe(true)

    const row = await prisma.tenantLockCode.findFirstOrThrow({ where: { id: issued.id } })
    // Sealed by the same box every other code in this product uses, so a
    // later `accesscode.reveal` reads it the same way.
    expect(openSecret(row.sealedCode, 'access-code')).toBe(issued.code)
  })

  it('gives each person their own, so the log can say who came in', async () => {
    const { lease, people } = await tenancy(['Ada', 'Bo'])
    const first = await issue(lease.id, people[0]!.id)
    const second = await issue(lease.id, people[1]!.id)
    expect(first.code).not.toBe(second.code)
    expect(opens(first.code)).toBe(true)
    expect(opens(second.code)).toBe(true)
  })

  it('refuses a second live code for the same person', async () => {
    const { lease, people } = await tenancy(['Ada'])
    await issue(lease.id, people[0]!.id)
    const again = await issueTenantLockCodeFor({
      leaseId: lease.id,
      tenantId: people[0]!.id,
      staffId,
    })
    // Two live codes for one person is two things to revoke when one of them
    // has to go.
    expect(again.refusal).toBe('already_holds_one')
  })

  it('refuses somebody who is not on the tenancy', async () => {
    const { lease } = await tenancy(['Ada'])
    const stranger = await prisma.tenant.create({
      data: { firstName: 'Not', lastName: `Here-${randomUUID().slice(0, 6)}` },
    })
    tenantIds.push(stranger.id)
    const result = await issueTenantLockCodeFor({
      leaseId: lease.id,
      tenantId: stranger.id,
      staffId,
    })
    expect(result.refusal).toBe('not_on_this_tenancy')
  })

  it('writes NO ROW when the device refuses', async () => {
    const { lease, people } = await tenancy(['Ada'])
    const offline = new SimulatedSmartLockAdapter({ fault: () => 'device_offline' })
    const spy = vi
      .spyOn(smartLockAdapter, 'issueCode')
      .mockImplementation((input) => offline.issueCode(input))
    try {
      const result = await issueTenantLockCodeFor({
        leaseId: lease.id,
        tenantId: people[0]!.id,
        staffId,
      })
      expect(result.refusal).toBe('device_refused')
      // A record of a code the door has never heard of is worse than no
      // record at all: somebody would read those digits out to a tenant.
      expect(await prisma.tenantLockCode.count({ where: { leaseId: lease.id } })).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('revoking', () => {
  it('stops the door', async () => {
    const { lease, people } = await tenancy(['Ada'])
    const issued = await issue(lease.id, people[0]!.id)
    expect(opens(issued.code)).toBe(true)

    const revoked = await revokeTenantLockCodes(
      { leaseId: lease.id },
      { reason: 'The tenancy ended.', staffId: null },
    )
    expect(revoked).toHaveLength(1)
    expect(revoked[0]!.reachedDevice).toBe(true)
    expect(opens(issued.code)).toBe(false)
  })

  it('takes one person off without touching anybody else’s', async () => {
    // The whole reason codes are per person: a roommate leaving must not
    // change the code for everybody staying.
    const { lease, people } = await tenancy(['Ada', 'Bo'])
    const leaving = await issue(lease.id, people[0]!.id)
    const staying = await issue(lease.id, people[1]!.id)

    await revokeTenantLockCodes(
      { leaseId: lease.id, tenantId: people[0]!.id },
      { reason: 'They came off the tenancy.', staffId: null },
    )
    expect(opens(leaving.code)).toBe(false)
    expect(opens(staying.code)).toBe(true)
  })

  it('records that the door may not agree when the lock is offline', async () => {
    const { lease, people } = await tenancy(['Ada'])
    const issued = await issue(lease.id, people[0]!.id)
    const spy = vi
      .spyOn(smartLockAdapter, 'revokeCode')
      .mockRejectedValue(new Error('simulated lock fault: device_offline'))
    try {
      const revoked = await revokeTenantLockCodes(
        { leaseId: lease.id },
        { reason: 'The tenancy ended.', staffId: null },
      )
      expect(revoked[0]!.reachedDevice).toBe(false)
    } finally {
      spy.mockRestore()
    }

    const row = await prisma.tenantLockCode.findFirstOrThrow({ where: { leaseId: lease.id } })
    // The row says revoked. The DOOR DOES NOT AGREE, and the row says that
    // too - which is what sends somebody to the property.
    expect(row.revokedAt).not.toBeNull()
    expect(row.revokeReachedDevice).toBe(false)
    expect(opens(issued.code)).toBe(true)
  })

  it('is a no-op when there is nothing live, rather than an error', async () => {
    const { lease } = await tenancy(['Ada'])
    expect(
      await revokeTenantLockCodes({ leaseId: lease.id }, { reason: 'nothing', staffId: null }),
    ).toEqual([])
  })

  it('keeps the first reason when a second revoke follows', async () => {
    const { lease, people } = await tenancy(['Ada'])
    await issue(lease.id, people[0]!.id)
    await revokeTenantLockCodes({ leaseId: lease.id }, { reason: 'first', staffId: null })
    await revokeTenantLockCodes({ leaseId: lease.id }, { reason: 'second', staffId: null })
    const row = await prisma.tenantLockCode.findFirstOrThrow({ where: { leaseId: lease.id } })
    expect(row.revokedReason).toBe('first')
  })
})
