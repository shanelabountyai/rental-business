// Turns parsed CSV rows into an import plan: what already exists (reused,
// never touched), what is new (created once, first row wins), and every
// violation - before anything is written (R-168, PRD §6.8).
//
// Pure and DB-free, like every other packages/core validator - the caller
// (apps/web) fetches a snapshot of what already exists and this module only
// ever reads it, never queries. That is what makes the dry-run diff and the
// actual commit share one function: preview calls this against a snapshot
// and shows the plan; commit calls it again against a fresh snapshot (so a
// row created by somebody else since the preview is still caught) and then
// executes exactly the plan it returned.
//
// ONE ROW = ONE (tenant, lease) PAIRING, not one lease. A lease with two
// roommates is two rows sharing the same property/unit/start date - see
// `leaseBatchKey` below - which is what lets a plain spreadsheet describe a
// multi-tenant tenancy without a repeating-group column for "tenant 2".
//
// Tenants are NEVER deduplicated, on the same reasoning
// apps/web/lib/leases/party-change-builder.ts already gives for never
// matching an incoming party by name: guessing that two rows describing the
// same name are the same person is a worse failure than a duplicate, because
// it would attach a stranger's history to somebody else. Legal entities,
// properties and units ARE matched against what already exists - those are
// exactly the records a returning import is expected to reuse.

import { addressComparisonKey } from '../property/address.ts'
import { isUsStateCode } from '../property/us-states.ts'
import { LEGAL_ENTITY_TYPES, PROPERTY_TYPES, validateLegalEntity, validateProperty } from '../property/validate.ts'
import { isValidTimezone } from '../scheduling/local-time.ts'
import { leaseCents, validateLease } from '../leases/validate.ts'
import { UNIT_STATUSES, validateUnit } from '../units/validate.ts'

export const IMPORT_COLUMNS = [
  'legal_entity_name',
  'legal_entity_type',
  'legal_entity_formation_state',
  'property_address_line1',
  'property_address_line2',
  'property_city',
  'property_state',
  'property_postal_code',
  'property_name',
  'property_type',
  'property_timezone',
  'property_history_starts_on',
  'unit_name',
  'unit_status',
  'unit_market_rent_dollars',
  'tenant_first_name',
  'tenant_last_name',
  'tenant_email',
  'tenant_phone',
  'lease_starts_on',
  'lease_ends_on',
  'lease_rent_dollars',
  'lease_rent_due_day',
  'lease_deposit_dollars',
  'lease_deposit_arrangement',
  'opening_balance_dollars',
  'opening_balance_as_of',
] as const
export type ImportColumn = (typeof IMPORT_COLUMNS)[number]

/// Columns a row must carry SOMETHING for, regardless of whether the entity
/// it names already exists - these identify the row itself. Everything
/// else (a legal entity's type, a property's timezone...) is required only
/// when THIS row is the one creating that record; see `RowContext`.
const ALWAYS_REQUIRED: readonly ImportColumn[] = [
  'legal_entity_name',
  'property_address_line1',
  'property_city',
  'property_state',
  'property_postal_code',
  'unit_name',
  'tenant_first_name',
  'tenant_last_name',
  'lease_starts_on',
  'lease_rent_dollars',
]

export interface RowError {
  line: number
  field: string
  message: string
}

export interface ExistingLegalEntity {
  id: string
  name: string
}

export interface ExistingProperty {
  id: string
  legalEntityId: string
  addressLine1: string
  postalCode: string
  historyStartsOn: string | null
}

export interface ExistingUnit {
  id: string
  propertyId: string
  name: string
}

export interface ExistingLease {
  id: string
  unitId: string
  startsOn: string
}

/// What the plan is built against. Fetched once by the caller (a handful of
/// `findMany`s scoped to the actor's portfolio), never queried from here.
export interface ImportSnapshot {
  legalEntities: readonly ExistingLegalEntity[]
  properties: readonly ExistingProperty[]
  units: readonly ExistingUnit[]
  leases: readonly ExistingLease[]
}

type Ref<T> =
  | { action: 'reuse'; id: string; data: T }
  | { action: 'create'; key: string; data: T }

export interface LegalEntityPlanData {
  name: string
  type: string
  formationState: string | null
}
export interface PropertyPlanData {
  legalEntityKey: string
  addressLine1: string
  addressLine2: string | null
  city: string
  state: string
  postalCode: string
  name: string
  propertyType: string
  timezone: string
  historyStartsOn: string | null
}
export interface UnitPlanData {
  propertyKey: string
  name: string
  status: string
  marketRentCents: number | null
}
export interface TenantPlanData {
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
}
export interface LeasePlanData {
  unitKey: string
  startsOn: string
  endsOn: string | null
  /// Derived, not a column: a row with no end date describes a tenancy
  /// already running month-to-month at migration time, which is the
  /// ordinary state for a portfolio being onboarded mid-tenancy. A row that
  /// DOES give an end date describes a fixed term instead.
  isMonthToMonth: boolean
  rentCents: number
  rentDueDay: number
  depositCents: number
  depositArrangement: 'CASH' | 'SURETY_BOND' | 'NONE'
  /// R-168a: what this tenancy owed the moment it was migrated in - the NET
  /// amount still outstanding as of `openingBalanceAsOf`, not a
  /// reconstruction of gross historical charges and payments. Same "known
  /// position, not reconstructed history" R-168 already applies to an
  /// imported deposit (owner decision, D-170). Null means no balance was
  /// owed at migration, which is the ordinary case.
  openingBalanceCents: number | null
  openingBalanceAsOf: string | null
}

export interface RowPlan {
  line: number
  legalEntity: Ref<LegalEntityPlanData>
  property: Ref<PropertyPlanData>
  unit: Ref<UnitPlanData>
  /// Always a fresh tenant - see the module header.
  tenant: TenantPlanData
  lease: Ref<LeasePlanData>
  /// First row to reach a given lease key is primary; every later row on the
  /// same tenancy is a roommate.
  isPrimaryTenant: boolean
}

export interface ImportPlan {
  /// Missing/unrecognized columns in the header - the whole file is
  /// rejected before a single row is read, since every row would fail the
  /// same way.
  headerErrors: string[]
  rows: RowPlan[]
  errors: RowError[]
  summary: {
    legalEntitiesToCreate: number
    propertiesToCreate: number
    unitsToCreate: number
    tenantsToCreate: number
    leasesToCreate: number
    leaseTenantsToCreate: number
  }
  /// Clean enough to commit: a header that parsed, at least one row, and no
  /// per-row violations. Commit refuses otherwise - fix the file and
  /// re-upload, rather than silently skipping the bad rows (an import that
  /// half-lands is the harder mess to find later).
  ok: boolean
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase()
}

export function planImport(headerRow: string[], dataRows: string[][], snapshot: ImportSnapshot): ImportPlan {
  const headerIndex = new Map<ImportColumn, number>()
  const seen = new Set<string>()
  for (const [i, raw] of headerRow.entries()) {
    const key = raw.trim().toLowerCase() as ImportColumn
    if ((IMPORT_COLUMNS as readonly string[]).includes(key)) {
      headerIndex.set(key, i)
      seen.add(key)
    }
  }
  const headerErrors: string[] = []
  for (const required of ALWAYS_REQUIRED) {
    if (!seen.has(required)) headerErrors.push(`Missing required column "${required}".`)
  }
  if (headerErrors.length > 0) {
    return {
      headerErrors,
      rows: [],
      errors: [],
      summary: {
        legalEntitiesToCreate: 0,
        propertiesToCreate: 0,
        unitsToCreate: 0,
        tenantsToCreate: 0,
        leasesToCreate: 0,
        leaseTenantsToCreate: 0,
      },
      ok: false,
    }
  }

  const cell = (row: string[], column: ImportColumn): string => {
    const i = headerIndex.get(column)
    return i == null ? '' : (row[i] ?? '').trim()
  }

  const existingEntityByName = new Map(snapshot.legalEntities.map((e) => [normalizeName(e.name), e]))
  const existingPropertyByKey = new Map(
    snapshot.properties.map((p) => [addressComparisonKey(p), p]),
  )
  const existingUnitByKey = new Map(
    snapshot.units.map((u) => [`${u.propertyId}|${normalizeName(u.name)}`, u]),
  )
  const existingLeaseByKey = new Map(snapshot.leases.map((l) => [`${l.unitId}|${l.startsOn}`, l]))

  // Batch-scoped "new record" keys, so two rows naming the same not-yet-
  // created legal entity/property/unit resolve to the SAME planned create
  // rather than two. Keyed by the same normalized value the DB match above
  // uses, so a row can never collide with itself across the two maps.
  const newEntityKeys = new Map<string, LegalEntityPlanData>()
  const newPropertyKeys = new Map<string, PropertyPlanData>()
  const newUnitKeys = new Map<string, UnitPlanData>()
  // Lease batch key -> the first row's terms, so every later row on the same
  // tenancy can be checked for agreement instead of silently overwriting.
  const leaseGroups = new Map<string, { data: LeasePlanData; firstLine: number }>()

  const errors: RowError[] = []
  const rows: RowPlan[] = []

  dataRows.forEach((raw, index) => {
    const line = index + 2 // header is line 1, matching what a spreadsheet shows
    if (raw.every((f) => f.trim() === '')) return // a blank line is not a row

    const rowErrorsBefore = errors.length
    const err = (field: string, message: string) => errors.push({ line, field, message })

    // --- legal entity -----------------------------------------------------
    const entityName = cell(raw, 'legal_entity_name')
    if (!entityName) err('legal_entity_name', 'Which legal entity owns this property?')
    const entityKey = normalizeName(entityName)
    let legalEntity: Ref<LegalEntityPlanData> | null = null
    const existingEntity = existingEntityByName.get(entityKey)
    if (existingEntity) {
      legalEntity = {
        action: 'reuse',
        id: existingEntity.id,
        data: { name: existingEntity.name, type: '', formationState: null },
      }
    } else if (entityName) {
      const type = cell(raw, 'legal_entity_type').toUpperCase()
      const formationState = cell(raw, 'legal_entity_formation_state') || null
      const data: LegalEntityPlanData = { name: entityName, type, formationState }
      const violations = validateLegalEntity(data)
      for (const v of violations) err(v.field === 'name' ? 'legal_entity_name' : `legal_entity_${v.field}`, v.message)
      legalEntity = { action: 'create', key: entityKey, data }
      newEntityKeys.set(entityKey, data)
    }

    // --- property -----------------------------------------------------
    const addressLine1 = cell(raw, 'property_address_line1')
    const postalCode = cell(raw, 'property_postal_code')
    const propertyKey = addressLine1 && postalCode ? addressComparisonKey({ addressLine1, postalCode }) : ''
    let property: Ref<PropertyPlanData> | null = null
    const existingProperty = propertyKey ? existingPropertyByKey.get(propertyKey) : undefined
    if (existingProperty) {
      // `property_history_starts_on` is read only when THIS row is what
      // creates the property (below). A value given for a property that
      // already exists is ignored rather than applied or flagged - a
      // report-window date is not worth blocking a whole import over, and
      // silently overwriting one an existing property already has would be
      // worse. Edit the property directly to set it there.
      property = {
        action: 'reuse',
        id: existingProperty.id,
        data: {
          legalEntityKey: entityKey,
          addressLine1,
          addressLine2: null,
          city: cell(raw, 'property_city'),
          state: cell(raw, 'property_state'),
          postalCode,
          name: '',
          propertyType: '',
          timezone: '',
          historyStartsOn: null,
        },
      }
    } else if (addressLine1) {
      const city = cell(raw, 'property_city')
      const state = cell(raw, 'property_state')
      const propertyType = cell(raw, 'property_type').toUpperCase()
      const timezone = cell(raw, 'property_timezone')
      const historyStartsOn = cell(raw, 'property_history_starts_on') || null
      const data: PropertyPlanData = {
        legalEntityKey: entityKey,
        addressLine1,
        addressLine2: cell(raw, 'property_address_line2') || null,
        city,
        state,
        postalCode,
        name: cell(raw, 'property_name') || addressLine1,
        propertyType,
        timezone,
        historyStartsOn,
      }
      const existingPlanned = newPropertyKeys.get(propertyKey)
      if (existingPlanned) {
        if (existingPlanned.historyStartsOn && historyStartsOn && existingPlanned.historyStartsOn !== historyStartsOn) {
          err('property_history_starts_on', `Conflicts with the history-start date given on an earlier row for this same property (line applies to the first row).`)
        } else if (historyStartsOn && !existingPlanned.historyStartsOn) {
          existingPlanned.historyStartsOn = historyStartsOn
        }
      } else {
        const violations = validateProperty({
          legalEntityId: entityKey || 'pending',
          name: data.name,
          propertyType: data.propertyType,
          timezone: data.timezone,
          addressLine1: data.addressLine1,
          addressLine2: data.addressLine2,
          city: data.city,
          state: data.state,
          postalCode: data.postalCode,
          historyStartsOn: data.historyStartsOn,
        })
        for (const v of violations) {
          err(v.field === 'historyStartsOn' ? 'property_history_starts_on' : `property_${v.field}`, v.message)
        }
        newPropertyKeys.set(propertyKey, data)
      }
      property = { action: 'create', key: propertyKey, data: newPropertyKeys.get(propertyKey)! }
    } else {
      err('property_address_line1', 'Street address is required.')
    }

    // --- unit -----------------------------------------------------
    const unitName = cell(raw, 'unit_name')
    const propertyIdOrKey = existingProperty ? existingProperty.id : propertyKey
    const unitKey = `${propertyIdOrKey}|${normalizeName(unitName)}`
    let unit: Ref<UnitPlanData> | null = null
    const existingUnit = existingProperty ? existingUnitByKey.get(unitKey) : undefined
    if (existingUnit) {
      unit = { action: 'reuse', id: existingUnit.id, data: { propertyKey: propertyIdOrKey, name: unitName, status: '', marketRentCents: null } }
    } else if (unitName && propertyIdOrKey) {
      const marketDollars = cell(raw, 'unit_market_rent_dollars')
      const marketRentCents = marketDollars ? Math.round(Number(marketDollars) * 100) : null
      const data: UnitPlanData = {
        propertyKey: propertyIdOrKey,
        name: unitName,
        status: cell(raw, 'unit_status').toUpperCase() || 'OCCUPIED',
        marketRentCents,
      }
      if (!newUnitKeys.has(unitKey)) {
        const violations = validateUnit({
          propertyId: propertyIdOrKey || 'pending',
          name: data.name,
          status: data.status,
          marketRentCents: data.marketRentCents,
        })
        for (const v of violations) err(`unit_${v.field}`, v.message)
        newUnitKeys.set(unitKey, data)
      }
      unit = { action: 'create', key: unitKey, data: newUnitKeys.get(unitKey)! }
    } else if (!unitName) {
      err('unit_name', 'Give the unit a name.')
    }

    // --- tenant (always new) -----------------------------------------------
    const tenant: TenantPlanData = {
      firstName: cell(raw, 'tenant_first_name'),
      lastName: cell(raw, 'tenant_last_name'),
      email: cell(raw, 'tenant_email') || null,
      phone: cell(raw, 'tenant_phone') || null,
    }
    if (!tenant.firstName) err('tenant_first_name', 'First name is required.')
    if (!tenant.lastName) err('tenant_last_name', 'Last name is required.')

    // --- lease -----------------------------------------------------
    const startsOn = cell(raw, 'lease_starts_on')
    const leaseKey = unit ? `${unit.action === 'reuse' ? unit.id : unit.key}|${startsOn}` : ''
    let lease: Ref<LeasePlanData> | null = null
    let isPrimaryTenant = false
    if (unit) {
      const existingLease = unit.action === 'reuse' ? existingLeaseByKey.get(leaseKey) : undefined
      if (existingLease) {
        lease = { action: 'reuse', id: existingLease.id, data: leaseGroups.get(leaseKey)?.data ?? placeholderLease(unitKey, startsOn) }
      } else {
        const rentCents = leaseCents(cell(raw, 'lease_rent_dollars'))
        const depositCents = leaseCents(cell(raw, 'lease_deposit_dollars')) ?? 0
        const endsOn = cell(raw, 'lease_ends_on') || null
        const openingBalanceDollars = cell(raw, 'opening_balance_dollars')
        const data: LeasePlanData = {
          unitKey: unit.action === 'reuse' ? unit.id : unit.key,
          startsOn,
          endsOn,
          isMonthToMonth: endsOn == null,
          rentCents: rentCents ?? 0,
          rentDueDay: Number(cell(raw, 'lease_rent_due_day') || '1'),
          depositCents,
          depositArrangement: (cell(raw, 'lease_deposit_arrangement').toUpperCase() || 'CASH') as LeasePlanData['depositArrangement'],
          openingBalanceCents: leaseCents(openingBalanceDollars),
          openingBalanceAsOf: cell(raw, 'opening_balance_as_of') || null,
        }
        const group = leaseGroups.get(leaseKey)
        if (group) {
          if (!sameLeaseTerms(group.data, data)) {
            err('lease_rent_dollars', `Lease terms differ from line ${group.firstLine} for the same tenancy (same unit and start date).`)
          }
          isPrimaryTenant = false
        } else {
          const violations = validateLease({
            unitId: unit.action === 'reuse' ? unit.id : unit.key || 'pending',
            startsOn,
            endsOn: data.endsOn,
            rentDollars: cell(raw, 'lease_rent_dollars'),
            depositDollars: cell(raw, 'lease_deposit_dollars') || null,
            depositArrangement: data.depositArrangement,
            rentDueDay: String(data.rentDueDay),
            isMonthToMonth: data.isMonthToMonth,
            mtmRentDollars: null,
          })
          for (const v of violations) err(`lease_${v.field}`, v.message)
          // R-168a: an opening balance is optional, but if either half is
          // given the other is required too - a bare amount with no as-of
          // date (or the reverse) is not something the charge below can act
          // on. Checked only on the row that creates the lease, same as
          // every other lease-term violation above.
          if (data.openingBalanceCents != null || data.openingBalanceAsOf != null) {
            if (data.openingBalanceCents == null || !data.openingBalanceAsOf) {
              err('opening_balance_dollars', 'Give both an opening balance and its as-of date, or neither.')
            } else if (data.openingBalanceCents <= 0) {
              err('opening_balance_dollars', 'Enter a positive dollar amount.')
            } else if (Number.isNaN(new Date(`${data.openingBalanceAsOf}T00:00:00Z`).getTime())) {
              err('opening_balance_as_of', 'Enter a valid date (YYYY-MM-DD).')
            } else if (data.openingBalanceAsOf < startsOn) {
              err('opening_balance_as_of', 'Cannot be before the lease start date.')
            } else {
              // A landlord claiming "no honest record before X"
              // (`historyStartsOn`) and also asserting a specific balance
              // owed before X is a contradiction on the same property -
              // whichever row creates the property (or the one already on
              // file) is what this checks against.
              const historyFloor =
                existingProperty?.historyStartsOn ??
                (property && property.action === 'create' ? property.data.historyStartsOn : null)
              if (historyFloor && data.openingBalanceAsOf < historyFloor) {
                err(
                  'opening_balance_as_of',
                  `Cannot be before this property's history-starts-on date (${historyFloor}).`,
                )
              }
            }
          }
          // A DEPOSIT CAP IS NOT CHECKED HERE, deliberately: `validateDepositAmount`
          // guards a NEW deposit against today's statutory ceiling, but every
          // lease this importer creates is `origin: 'INHERITED'` - the deposit
          // was already collected, under whatever rule applied when it was,
          // and re-applying today's cap to a historical fact would be asking
          // an owner to shrink money already held. R-041's cap still governs
          // every deposit COLLECTED going forward.
          leaseGroups.set(leaseKey, { data, firstLine: line })
          isPrimaryTenant = true
        }
        lease = { action: 'create', key: leaseKey, data: leaseGroups.get(leaseKey)!.data }
      }
    }

    if (errors.length === rowErrorsBefore && legalEntity && property && unit && lease) {
      rows.push({ line, legalEntity, property, unit, tenant, lease, isPrimaryTenant })
    }
  })

  const leasesToCreate = new Set(rows.filter((r) => r.lease.action === 'create').map((r) => r.lease.action === 'create' ? r.lease.key : '')).size

  const summary = {
    legalEntitiesToCreate: newEntityKeys.size,
    propertiesToCreate: newPropertyKeys.size,
    unitsToCreate: newUnitKeys.size,
    tenantsToCreate: rows.length,
    leasesToCreate,
    leaseTenantsToCreate: rows.length,
  }

  return {
    headerErrors: [],
    rows,
    errors,
    summary,
    ok: errors.length === 0 && rows.length > 0,
  }
}

function placeholderLease(unitKey: string, startsOn: string): LeasePlanData {
  return {
    unitKey,
    startsOn,
    endsOn: null,
    isMonthToMonth: true,
    rentCents: 0,
    rentDueDay: 1,
    depositCents: 0,
    depositArrangement: 'CASH',
    openingBalanceCents: null,
    openingBalanceAsOf: null,
  }
}

function sameLeaseTerms(a: LeasePlanData, b: LeasePlanData): boolean {
  return (
    a.endsOn === b.endsOn &&
    a.rentCents === b.rentCents &&
    a.rentDueDay === b.rentDueDay &&
    a.depositCents === b.depositCents &&
    a.depositArrangement === b.depositArrangement &&
    a.openingBalanceCents === b.openingBalanceCents &&
    a.openingBalanceAsOf === b.openingBalanceAsOf
  )
}

// Re-exported so callers building the upload form's dropdowns/help text
// don't need a second import from packages/core/property and packages/core/units.
export { LEGAL_ENTITY_TYPES, PROPERTY_TYPES, isUsStateCode, isValidTimezone, UNIT_STATUSES }
