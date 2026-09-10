import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { taxExportFacts } from './queries.ts'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// The wiring the pure export tests cannot reach (R-193): which
// `PropertyExpense` rows the query hands `buildTaxExport`. The window is the
// part with teeth - a monthly series started in an earlier year must arrive,
// one that ended before the year must not, and a property outside scope or
// another entity's row must never.

const YEAR = 2026

let entityId: string
let otherEntityId: string
let staffId: string
let oakId: string
let elmId: string

/// Oak only. Elm is on the same entity and outside this reader's scope.
function scopeOf(): ResolvedScope {
  return {
    selection: { kind: 'all' },
    availableEntities: [{ id: entityId, name: 'R193 Holdings' }],
    availableProperties: [
      { id: oakId, name: 'Oak St', legalEntityId: entityId, timezone: 'America/Chicago' },
    ],
    propertyIds: [oakId],
    switchable: false,
  } as ResolvedScope
}

async function makeProperty(legalEntityId: string, name: string): Promise<string> {
  const property = await prisma.property.create({
    data: {
      legalEntityId,
      name,
      addressLine1: '1 Test St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  return property.id
}

async function expense(data: {
  legalEntityId?: string
  propertyId: string | null
  description: string
  paidOn: string
  recursMonthly?: boolean
  recurrenceEndsOn?: string
}) {
  await prisma.propertyExpense.create({
    data: {
      legalEntityId: data.legalEntityId ?? entityId,
      propertyId: data.propertyId,
      category: 'TAXES',
      amountCents: 10_000,
      description: data.description,
      paidOn: new Date(`${data.paidOn}T00:00:00Z`),
      recursMonthly: data.recursMonthly ?? false,
      recurrenceEndsOn: data.recurrenceEndsOn ? new Date(`${data.recurrenceEndsOn}T00:00:00Z`) : null,
      recordedByStaffId: staffId,
    },
  })
}

beforeAll(async () => {
  const stamp = `r193-${Date.now()}`
  entityId = (await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })).id
  otherEntityId = (await prisma.legalEntity.create({ data: { name: `${stamp}-other`, type: 'LLC' } })).id
  oakId = await makeProperty(entityId, `Oak-${stamp}`)
  elmId = await makeProperty(entityId, `Elm-${stamp}`)
  const otherHouse = await makeProperty(otherEntityId, `Ash-${stamp}`)
  staffId = (await prisma.staffUser.create({ data: { email: `${stamp}@example.test`, name: 'R193 Tester' } })).id

  await expense({ propertyId: oakId, description: 'in-year one-off', paidOn: '2026-01-30' })
  await expense({ propertyId: oakId, description: 'last-year one-off', paidOn: '2025-12-30' })
  await expense({ propertyId: oakId, description: 'running series', paidOn: '2025-11-05', recursMonthly: true })
  await expense({
    propertyId: oakId,
    description: 'series ended last year',
    paidOn: '2025-01-05',
    recursMonthly: true,
    recurrenceEndsOn: '2025-12-05',
  })
  await expense({ propertyId: null, description: 'entity-wide premium', paidOn: '2026-03-01' })
  await expense({ propertyId: elmId, description: 'out-of-scope house', paidOn: '2026-02-01' })
  await expense({
    legalEntityId: otherEntityId,
    propertyId: otherHouse,
    description: 'another entity',
    paidOn: '2026-02-01',
  })
})

afterAll(async () => {
  const entities = [entityId, otherEntityId]
  await prisma.propertyExpense.deleteMany({ where: { legalEntityId: { in: entities } } })
  await prisma.property.deleteMany({ where: { legalEntityId: { in: entities } } })
  await prisma.staffUser.deleteMany({ where: { id: staffId } })
  await prisma.legalEntity.deleteMany({ where: { id: { in: entities } } })
})

describe('taxExportFacts with property expenses', () => {
  it('reads the entity’s own and in-scope rows, over the year a series runs into', async () => {
    const report = await taxExportFacts(scopeOf(), entityId, YEAR, 'cash')
    expect(report).not.toBeNull()

    const mapped = report!.lines.filter((line) => line.sourceKind === 'PropertyExpense')
    const described = new Set(mapped.map((line) => line.description))
    expect(described).toEqual(new Set(['in-year one-off', 'running series (monthly)']))
    // Every 5th from January 2026 through today - at least January, and never
    // a 2025 month.
    const series = mapped.filter((line) => line.description === 'running series (monthly)')
    expect(series[0]?.bookedOn).toBe('2026-01-05')
    expect(series.every((line) => line.bookedOn!.startsWith('2026-'))).toBe(true)

    expect(report!.exceptions.map((row) => row.description)).toEqual(['entity-wide premium'])

    // The last-year one-off is fetched only if a window bug lets it in, and
    // it would then be counted out rather than booked. Neither the ended
    // series, Elm's row nor the other entity's is fetched at all.
    expect(report!.counts.facts).toBe(3)
    expect(report!.counts.outOfYear).toBe(0)
  })
})
