import { describe, expect, it } from 'vitest'
import { IMPORT_COLUMNS, type ImportSnapshot, planImport } from './plan.ts'

const EMPTY_SNAPSHOT: ImportSnapshot = { legalEntities: [], properties: [], units: [], leases: [] }

const HEADER = [...IMPORT_COLUMNS]

function row(overrides: Partial<Record<(typeof IMPORT_COLUMNS)[number], string>>): string[] {
  const defaults: Record<(typeof IMPORT_COLUMNS)[number], string> = {
    legal_entity_name: 'Riverside Holdings LLC',
    legal_entity_type: 'LLC',
    legal_entity_formation_state: 'TX',
    property_address_line1: '123 Elm St',
    property_address_line2: '',
    property_city: 'Austin',
    property_state: 'TX',
    property_postal_code: '78701',
    property_name: 'Elm Street House',
    property_type: 'SINGLE_FAMILY',
    property_timezone: 'America/Chicago',
    property_history_starts_on: '',
    unit_name: 'Main house',
    unit_status: 'OCCUPIED',
    unit_market_rent_dollars: '1500',
    tenant_first_name: 'Grant',
    tenant_last_name: 'Okafor',
    tenant_email: 'grant@example.test',
    tenant_phone: '',
    lease_starts_on: '2024-01-01',
    lease_ends_on: '',
    lease_rent_dollars: '1500',
    lease_rent_due_day: '1',
    lease_deposit_dollars: '1500',
    lease_deposit_arrangement: 'CASH',
    opening_balance_dollars: '',
    opening_balance_as_of: '',
  }
  const merged = { ...defaults, ...overrides }
  return HEADER.map((column) => merged[column])
}

describe('planImport - header', () => {
  it('rejects a header missing a required column', () => {
    const plan = planImport(['legal_entity_name'], [], EMPTY_SNAPSHOT)
    expect(plan.ok).toBe(false)
    expect(plan.headerErrors.length).toBeGreaterThan(0)
  })
})

describe('planImport - a single clean row', () => {
  it('plans every entity as a create', () => {
    const plan = planImport(HEADER, [row({})], EMPTY_SNAPSHOT)
    expect(plan.errors).toEqual([])
    expect(plan.ok).toBe(true)
    expect(plan.rows).toHaveLength(1)
    const [planned] = plan.rows
    expect(planned!.legalEntity.action).toBe('create')
    expect(planned!.property.action).toBe('create')
    expect(planned!.unit.action).toBe('create')
    expect(planned!.lease.action).toBe('create')
    expect(planned!.isPrimaryTenant).toBe(true)
    expect(plan.summary).toEqual({
      legalEntitiesToCreate: 1,
      propertiesToCreate: 1,
      unitsToCreate: 1,
      tenantsToCreate: 1,
      leasesToCreate: 1,
      leaseTenantsToCreate: 1,
    })
  })

  it('reports a missing required field against the right row', () => {
    const plan = planImport(HEADER, [row({ tenant_last_name: '' })], EMPTY_SNAPSHOT)
    expect(plan.ok).toBe(false)
    expect(plan.rows).toHaveLength(0)
    expect(plan.errors).toContainEqual({ line: 2, field: 'tenant_last_name', message: 'Last name is required.' })
  })
})

describe('planImport - reusing what already exists', () => {
  it('matches a legal entity by name and a property by address, never re-creating them', () => {
    const snapshot: ImportSnapshot = {
      legalEntities: [{ id: 'entity_1', name: 'Riverside Holdings LLC' }],
      properties: [
        { id: 'prop_1', legalEntityId: 'entity_1', addressLine1: '123 Elm Street', postalCode: '78701-1234', historyStartsOn: null },
      ],
      units: [],
      leases: [],
    }
    const plan = planImport(HEADER, [row({})], snapshot)
    expect(plan.errors).toEqual([])
    const [planned] = plan.rows
    expect(planned!.legalEntity).toEqual({ action: 'reuse', id: 'entity_1', data: expect.anything() })
    expect(planned!.property).toEqual({ action: 'reuse', id: 'prop_1', data: expect.anything() })
    expect(plan.summary.legalEntitiesToCreate).toBe(0)
    expect(plan.summary.propertiesToCreate).toBe(0)
  })
})

describe('planImport - a multi-tenant lease', () => {
  it('groups two rows on the same unit and start date into one lease, second tenant non-primary', () => {
    const plan = planImport(
      HEADER,
      [row({ tenant_first_name: 'Grant' }), row({ tenant_first_name: 'Robin', tenant_last_name: 'Okafor' })],
      EMPTY_SNAPSHOT,
    )
    expect(plan.errors).toEqual([])
    expect(plan.ok).toBe(true)
    expect(plan.rows).toHaveLength(2)
    expect(plan.rows[0]!.isPrimaryTenant).toBe(true)
    expect(plan.rows[1]!.isPrimaryTenant).toBe(false)
    // Same planned unit and lease key - one lease, not two.
    expect(plan.summary.leasesToCreate).toBe(1)
    expect(plan.summary.leaseTenantsToCreate).toBe(2)
  })

  it('flags a second row on the same tenancy that disagrees on rent', () => {
    const plan = planImport(
      HEADER,
      [row({ tenant_first_name: 'Grant' }), row({ tenant_first_name: 'Robin', lease_rent_dollars: '1600' })],
      EMPTY_SNAPSHOT,
    )
    expect(plan.ok).toBe(false)
    expect(plan.errors.some((e) => e.line === 3 && e.field === 'lease_rent_dollars')).toBe(true)
  })
})

describe('planImport - opening balances (R-168a)', () => {
  it('plans a clean opening balance onto the new lease', () => {
    const plan = planImport(
      HEADER,
      [row({ opening_balance_dollars: '450', opening_balance_as_of: '2024-01-15' })],
      EMPTY_SNAPSHOT,
    )
    expect(plan.errors).toEqual([])
    expect(plan.ok).toBe(true)
    const [planned] = plan.rows
    expect(planned!.lease.data.openingBalanceCents).toBe(45000)
    expect(planned!.lease.data.openingBalanceAsOf).toBe('2024-01-15')
  })

  it('requires both the amount and the as-of date, not just one', () => {
    const plan = planImport(HEADER, [row({ opening_balance_dollars: '450' })], EMPTY_SNAPSHOT)
    expect(plan.ok).toBe(false)
    expect(plan.errors).toContainEqual({
      line: 2,
      field: 'opening_balance_dollars',
      message: 'Give both an opening balance and its as-of date, or neither.',
    })
  })

  it('rejects an as-of date before the lease start date', () => {
    const plan = planImport(
      HEADER,
      [row({ opening_balance_dollars: '450', opening_balance_as_of: '2023-12-01' })],
      EMPTY_SNAPSHOT,
    )
    expect(plan.ok).toBe(false)
    expect(plan.errors.some((e) => e.field === 'opening_balance_as_of')).toBe(true)
  })

  it("rejects an as-of date before the property's history-starts-on", () => {
    const plan = planImport(
      HEADER,
      [
        row({
          property_history_starts_on: '2024-06-01',
          opening_balance_dollars: '450',
          opening_balance_as_of: '2024-01-15',
        }),
      ],
      EMPTY_SNAPSHOT,
    )
    expect(plan.ok).toBe(false)
    expect(plan.errors.some((e) => e.field === 'opening_balance_as_of')).toBe(true)
  })

  it('flags a roommate row that disagrees on the opening balance', () => {
    const plan = planImport(
      HEADER,
      [
        row({ tenant_first_name: 'Grant', opening_balance_dollars: '450', opening_balance_as_of: '2024-01-15' }),
        row({ tenant_first_name: 'Robin', lease_rent_dollars: '1500' }),
      ],
      EMPTY_SNAPSHOT,
    )
    expect(plan.ok).toBe(false)
    expect(plan.errors.some((e) => e.line === 3 && e.field === 'lease_rent_dollars')).toBe(true)
  })

  it('is optional - a row with neither cell plans no balance', () => {
    const plan = planImport(HEADER, [row({})], EMPTY_SNAPSHOT)
    expect(plan.ok).toBe(true)
    expect(plan.rows[0]!.lease.data.openingBalanceCents).toBeNull()
  })
})

describe('planImport - blank lines', () => {
  it('ignores a fully blank row rather than reporting it as an error', () => {
    const plan = planImport(HEADER, [row({}), HEADER.map(() => '')], EMPTY_SNAPSHOT)
    expect(plan.rows).toHaveLength(1)
    expect(plan.errors).toEqual([])
  })
})
