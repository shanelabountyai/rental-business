'use server'

import { randomUUID } from 'node:crypto'
import {
  type ImportPlan,
  type ImportSnapshot,
  type RowPlan,
  parseCsv,
  planImport,
} from '@rental/core/import'
import { parseLeaseDate } from '@rental/core/leases'
import { utcToBusinessDate } from '@rental/core/scheduling'
import { prisma, type Prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { requirePermission } from '@/lib/auth/guard.ts'
import { raiseIntakeTasks } from '@/lib/leases/intake.ts'

// Bulk CSV import (R-168, PRD §6.8): entities, tenants and leases only -
// opening balances are a separate item (D-11 means they cannot be a direct
// ledger write, and that mechanism needs its own row).
//
// Gated on a bare `property.write` - no resource - exactly like
// `createLegalEntity` (apps/web/lib/properties/actions.ts): a portfolio can
// be onboarded only by a portfolio-wide grant, never a manager scoped to one
// property or one entity.
//
// The dry-run and the commit call the SAME `planImport()` against a FRESH
// snapshot each time, rather than trusting whatever the preview saw - a row
// created by somebody else in between is caught, not silently overwritten.
// The raw CSV text travels forward from preview to commit in a hidden field
// (see the form component), not client state - this works with JavaScript
// off, same as every other form in this app.

export interface ImportFormState {
  error?: string
  notice?: string
  csvText?: string
  headerErrors?: string[]
  rowErrors?: { line: number; field: string; message: string }[]
  rowCount?: number
  summary?: ImportPlan['summary']
  ok?: boolean
  committed?: {
    legalEntities: number
    properties: number
    units: number
    tenants: number
    leases: number
  }
}

async function readCsvText(formData: FormData): Promise<string | null> {
  const file = formData.get('file')
  if (file instanceof File && file.size > 0) return file.text()
  const carried = formData.get('csvText')
  return typeof carried === 'string' && carried.trim() ? carried : null
}

async function buildSnapshot(): Promise<ImportSnapshot> {
  const [legalEntities, properties, units, leases] = await Promise.all([
    prisma.legalEntity.findMany({ select: { id: true, name: true } }),
    prisma.property.findMany({
      select: { id: true, legalEntityId: true, addressLine1: true, postalCode: true, historyStartsOn: true },
    }),
    prisma.unit.findMany({ select: { id: true, propertyId: true, name: true } }),
    prisma.lease.findMany({ select: { id: true, unitId: true, startsOn: true } }),
  ])
  return {
    legalEntities,
    properties: properties.map((p) => ({
      ...p,
      historyStartsOn: p.historyStartsOn != null ? utcToBusinessDate(p.historyStartsOn) : null,
    })),
    units,
    leases: leases.map((l) => ({ id: l.id, unitId: l.unitId, startsOn: utcToBusinessDate(l.startsOn) })),
  }
}

function planToState(csvText: string, plan: ImportPlan): ImportFormState {
  const rowCount = plan.rows.length + new Set(plan.errors.map((e) => e.line)).size
  return {
    csvText,
    error: plan.ok
      ? undefined
      : `Fix ${plan.errors.length} error${plan.errors.length === 1 ? '' : 's'} below, then upload again.`,
    headerErrors: plan.headerErrors,
    rowErrors: plan.errors,
    rowCount,
    summary: plan.summary,
    ok: plan.ok,
  }
}

async function previewImport(csvText: string): Promise<ImportFormState> {
  const rows = parseCsv(csvText)
  if (rows.length === 0) return { error: 'That file has no rows.', csvText }
  const [header, ...data] = rows
  const snapshot = await buildSnapshot()
  const plan = planImport(header!, data, snapshot)

  if (plan.headerErrors.length > 0) {
    return {
      csvText,
      error: 'That header is missing a required column — see below.',
      headerErrors: plan.headerErrors,
      ok: false,
    }
  }
  return planToState(csvText, plan)
}

/**
 * One action for both steps, distinguished by which submit button fired it
 * (`intent`, a plain named `<button>` value - see ImportForm) rather than
 * two separate actions - the same shape `createProperty`'s own
 * `confirmDuplicate` resubmit takes. That is what lets "Preview" and "Import
 * these rows" live as two buttons on one `<form>` with no client state and
 * no JavaScript required.
 */
export async function runImport(
  _previous: ImportFormState,
  formData: FormData,
): Promise<ImportFormState> {
  await requirePermission('property.write')

  const csvText = await readCsvText(formData)
  if (!csvText) return { error: 'Choose a CSV file.' }

  if (formData.get('intent') !== 'commit') return previewImport(csvText)

  const rows = parseCsv(csvText)
  if (rows.length === 0) return { error: 'That file has no rows.', csvText }
  const [header, ...data] = rows
  const snapshot = await buildSnapshot()
  const plan = planImport(header!, data, snapshot)

  if (!plan.ok) {
    // Re-checked, not trusted from the preview render: a row created by
    // somebody else since the dry-run can turn a clean plan into a dirty
    // one, and committing anyway is exactly the half-landed import this
    // whole flow exists to prevent.
    return planToState(csvText, plan)
  }

  const batchId = randomUUID()
  const newLeaseIds: string[] = []

  const result = await prisma.$transaction(async (tx) => {
    const entityIds = new Map<string, string>()
    const propertyIds = new Map<string, string>()
    const unitIds = new Map<string, string>()
    const leaseIds = new Map<string, string>()

    for (const row of plan.rows) {
      const legalEntityId = await resolveLegalEntity(tx, row, entityIds, batchId)
      const propertyId = await resolveProperty(tx, row, legalEntityId, propertyIds, batchId)
      const unitId = await resolveUnit(tx, row, propertyId, unitIds, batchId)

      const tenant = await tx.tenant.create({
        data: {
          firstName: row.tenant.firstName,
          lastName: row.tenant.lastName,
          email: row.tenant.email,
          phone: row.tenant.phone,
        },
      })
      await audit(
        {
          action: 'tenant.created',
          entityType: 'Tenant',
          entityId: tenant.id,
          after: { firstName: tenant.firstName, lastName: tenant.lastName, source: 'import', batchId },
        },
        tx,
      )

      let leaseId: string
      if (row.lease.action === 'reuse') {
        leaseId = row.lease.id
      } else if (leaseIds.has(row.lease.key)) {
        leaseId = leaseIds.get(row.lease.key)!
      } else {
        const data = row.lease.data
        const created = await tx.lease.create({
          data: {
            propertyId,
            unitId,
            status: 'DRAFT',
            // Every lease this importer writes is an inherited tenancy by
            // definition - there is no application, no screening, whatever
            // paperwork exists is whatever the migration brought over. See
            // LeaseOrigin's own schema comment.
            origin: 'INHERITED',
            depositTransferStatus: 'UNKNOWN',
            startsOn: parseLeaseDate(data.startsOn)!,
            endsOn: data.endsOn ? parseLeaseDate(data.endsOn) : null,
            rentCents: data.rentCents,
            rentDueDay: data.rentDueDay,
            depositCents: data.depositCents,
            depositArrangement: data.depositArrangement as never,
            isMonthToMonth: data.isMonthToMonth,
          },
        })
        leaseId = created.id
        leaseIds.set(row.lease.key, leaseId)
        newLeaseIds.push(leaseId)
        await audit(
          {
            action: 'lease.created',
            entityType: 'Lease',
            entityId: leaseId,
            propertyId,
            after: {
              origin: 'INHERITED',
              unitId,
              startsOn: created.startsOn.toISOString(),
              rentCents: created.rentCents,
              source: 'import',
              batchId,
            },
          },
          tx,
        )
      }

      await tx.leaseTenant.create({
        data: { leaseId, tenantId: tenant.id, isPrimary: row.isPrimaryTenant },
      })
      // Same action `addLeaseTenant` uses for the ordinary path
      // (apps/web/lib/leases/actions.ts) - "a tenant joined this lease" is
      // one fact regardless of whether the lease itself is new or existing.
      await audit(
        {
          action: 'lease.party_changed',
          entityType: 'Lease',
          entityId: leaseId,
          propertyId,
          after: { added: 'tenant', tenantId: tenant.id, isPrimary: row.isPrimaryTenant, source: 'import', batchId },
        },
        tx,
      )
    }

    await audit(
      {
        action: 'import.committed',
        entityType: 'Import',
        entityId: batchId,
        after: {
          rows: plan.rows.length,
          legalEntitiesCreated: entityIds.size,
          propertiesCreated: propertyIds.size,
          unitsCreated: unitIds.size,
          leasesCreated: leaseIds.size,
        },
      },
      tx,
    )

    return {
      legalEntities: entityIds.size,
      properties: propertyIds.size,
      units: unitIds.size,
      tenants: plan.rows.length,
      leases: leaseIds.size,
    }
  })

  // Outside the transaction, same posture as createLease's own INHERITED
  // path: the leases exist whether or not these prompts land, and a failed
  // Task write must not roll back records that already committed.
  await Promise.all(
    newLeaseIds.map((leaseId) =>
      raiseIntakeTasks(leaseId).catch((error) => {
        console.error(`[import] intake tasks failed for lease ${leaseId}`, error)
      }),
    ),
  )

  revalidatePath('/properties')
  revalidatePath('/leases')
  return {
    committed: result,
    ok: true,
    notice: `Imported ${result.tenants} tenant${result.tenants === 1 ? '' : 's'} across ${result.leases} lease${result.leases === 1 ? '' : 's'} (${result.legalEntities} new legal ${result.legalEntities === 1 ? 'entity' : 'entities'}, ${result.properties} new propert${result.properties === 1 ? 'y' : 'ies'}, ${result.units} new unit${result.units === 1 ? '' : 's'}).`,
  }
}

async function resolveLegalEntity(
  tx: Prisma.TransactionClient,
  row: RowPlan,
  createdIds: Map<string, string>,
  batchId: string,
): Promise<string> {
  if (row.legalEntity.action === 'reuse') return row.legalEntity.id
  const existing = createdIds.get(row.legalEntity.key)
  if (existing) return existing
  const created = await tx.legalEntity.create({
    data: {
      name: row.legalEntity.data.name,
      type: row.legalEntity.data.type as never,
      formationState: row.legalEntity.data.formationState,
    },
  })
  createdIds.set(row.legalEntity.key, created.id)
  await audit(
    {
      action: 'legal_entity.created',
      entityType: 'LegalEntity',
      entityId: created.id,
      after: { name: created.name, type: created.type, source: 'import', batchId },
    },
    tx,
  )
  return created.id
}

async function resolveProperty(
  tx: Prisma.TransactionClient,
  row: RowPlan,
  legalEntityId: string,
  createdIds: Map<string, string>,
  batchId: string,
): Promise<string> {
  if (row.property.action === 'reuse') return row.property.id
  const existing = createdIds.get(row.property.key)
  if (existing) return existing
  const data = row.property.data
  const created = await tx.property.create({
    data: {
      legalEntityId,
      name: data.name,
      addressLine1: data.addressLine1,
      addressLine2: data.addressLine2,
      city: data.city,
      state: data.state,
      postalCode: data.postalCode,
      propertyType: data.propertyType as never,
      // Every property this importer creates needs SOME timezone - the
      // form-fed create path defaults nothing (D-3: a wrong zone silently
      // breaks every scheduled job for the address), so `planImport` already
      // refused a blank one before this ever runs.
      timezone: data.timezone,
      historyStartsOn: data.historyStartsOn ? new Date(`${data.historyStartsOn}T00:00:00Z`) : null,
    },
  })
  createdIds.set(row.property.key, created.id)
  await audit(
    {
      action: 'property.created',
      entityType: 'Property',
      entityId: created.id,
      propertyId: created.id,
      after: {
        legalEntityId,
        addressLine1: created.addressLine1,
        city: created.city,
        state: created.state,
        source: 'import',
        batchId,
      },
    },
    tx,
  )
  return created.id
}

async function resolveUnit(
  tx: Prisma.TransactionClient,
  row: RowPlan,
  propertyId: string,
  createdIds: Map<string, string>,
  batchId: string,
): Promise<string> {
  if (row.unit.action === 'reuse') return row.unit.id
  const existing = createdIds.get(row.unit.key)
  if (existing) return existing
  const data = row.unit.data
  const created = await tx.unit.create({
    data: {
      propertyId,
      name: data.name,
      status: data.status as never,
      marketRentCents: data.marketRentCents,
    },
  })
  createdIds.set(row.unit.key, created.id)
  await audit(
    {
      action: 'unit.created',
      entityType: 'Unit',
      entityId: created.id,
      propertyId,
      after: { name: created.name, status: created.status, source: 'import', batchId },
    },
    tx,
  )
  return created.id
}
