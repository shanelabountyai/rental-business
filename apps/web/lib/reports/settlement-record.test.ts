import { randomUUID } from 'node:crypto'
import type { BusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { recordedSettlements } from './settlement.ts'

// The recorded inter-entity transfer against a real database (R-198).
//
// What only the database can prove: that the row is evidence, not a draft - no
// edit, no delete, no amount the report did not support - and that the overlap
// predicate the page and the action share draws the boundary on the right day.
// The screen and the archived PDF are e2e/settlement.spec.ts.

const day = (value: string) => value as BusinessDate

let entityId: string
let staffId: string
let settlementId: string

async function archivedReport() {
  return prisma.document.create({
    data: {
      legalEntityId: entityId,
      type: 'SETTLEMENT_REPORT',
      fileName: 'settlement-2026-03-01-to-2026-03-31.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1,
      storageKey: `test/settlement-${randomUUID()}.pdf`,
      uploadedByStaffId: staffId,
    },
  })
}

beforeAll(async () => {
  const entity = await prisma.legalEntity.create({
    data: { name: `Settlement Record LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityId = entity.id
  const staff = await prisma.staffUser.create({
    data: { email: `settlement-record-${randomUUID()}@example.test`, name: 'Settlement Record' },
  })
  staffId = staff.id
  const document = await archivedReport()
  const settlement = await prisma.entitySettlement.create({
    data: {
      legalEntityId: entityId,
      windowFrom: new Date('2026-03-01T00:00:00Z'),
      windowTo: new Date('2026-03-31T00:00:00Z'),
      grossCents: 150_000,
      transferredCents: 145_525,
      transferredOn: new Date('2026-04-04T00:00:00Z'),
      reference: 'TRF-88213',
      documentId: document.id,
      recordedById: staffId,
    },
  })
  settlementId = settlement.id
})

// Nothing here can be deleted - the settlement is append-only and holds the
// document, the entity and the staff user by RESTRICT - so they are retired.
afterAll(async () => {
  await prisma.legalEntity.update({ where: { id: entityId }, data: { active: false } })
  await prisma.staffUser.update({ where: { id: staffId }, data: { active: false } })
  await prisma.$disconnect()
})

describe('a recorded transfer', () => {
  it('cannot be edited or deleted', async () => {
    await expect(
      prisma.entitySettlement.update({ where: { id: settlementId }, data: { transferredCents: 1 } }),
    ).rejects.toThrow(/append-only/)
    await expect(prisma.entitySettlement.delete({ where: { id: settlementId } })).rejects.toThrow(
      /append-only/,
    )
  })

  it('cannot move more than the report said was owed, or be dated before its range ended', async () => {
    const base = {
      legalEntityId: entityId,
      windowFrom: new Date('2026-05-01T00:00:00Z'),
      windowTo: new Date('2026-05-31T00:00:00Z'),
      grossCents: 150_000,
      transferredCents: 150_000,
      transferredOn: new Date('2026-06-02T00:00:00Z'),
      reference: 'TRF-CHECK',
      recordedById: staffId,
    }
    await expect(
      prisma.entitySettlement.create({
        data: { ...base, transferredCents: 150_001, documentId: (await archivedReport()).id },
      }),
    ).rejects.toThrow()
    await expect(
      prisma.entitySettlement.create({
        data: {
          ...base,
          transferredOn: new Date('2026-05-30T00:00:00Z'),
          documentId: (await archivedReport()).id,
        },
      }),
    ).rejects.toThrow()
  })
})

describe('which recorded transfers a range collides with', () => {
  it('counts a range sharing even the last day, and not one that begins the day after', async () => {
    expect(await recordedSettlements([entityId], day('2026-03-31'), day('2026-04-30'))).toHaveLength(1)
    expect(await recordedSettlements([entityId], day('2026-02-01'), day('2026-03-01'))).toHaveLength(1)
    expect(await recordedSettlements([entityId], day('2026-04-01'), day('2026-04-30'))).toHaveLength(0)
    expect(await recordedSettlements([entityId], day('2026-02-01'), day('2026-02-28'))).toHaveLength(0)
  })

  it('reads the calendar days back unshifted', async () => {
    const [row] = await recordedSettlements([entityId], day('2026-03-01'), day('2026-03-31'))
    expect(row).toMatchObject({
      windowFrom: '2026-03-01',
      windowTo: '2026-03-31',
      transferredOn: '2026-04-04',
      grossCents: 150_000,
      transferredCents: 145_525,
      recordedByName: 'Settlement Record',
    })
  })
})
