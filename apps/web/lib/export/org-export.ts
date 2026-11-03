import 'server-only'

import { isSensitiveField, REDACTED } from '@rental/core/audit'
import { toCsv } from '@rental/core/ledger'
import { businessDateToUtc, utcToBusinessDate } from '@rental/core/scheduling'
import { Prisma, prisma } from '@rental/db'
import { isUniqueViolation } from '@/lib/db/unique-violation.ts'
import { MissingStoredObjectError } from '@/lib/storage/adapter.ts'
import { storage } from '@/lib/storage/index.ts'
import { type ZipEntry, zip } from './zip.ts'

// The full organisation export (R-299, PRD 10 §8): one CSV per org-owned
// table in schema order, every `Document` file, and a manifest, zipped into
// storage under a `JobRun`.
//
// "Org-owned" is READ FROM THE SCHEMA, not listed: every model with an
// `orgId` column (D-339 put one on every org-scoped table), plus the
// Organization row itself and the staff who are its members. A table added
// next month is in the export without anyone remembering this file. The
// evidence packets are in it the same way: every packet ever exported is
// archived as a `Document` (R-052's rule), so its file is under documents/.
//
// Secrets are blanked with the AUDIT LOG's predicate (`isSensitiveField`),
// whose own test walks the whole schema - so a credential column cannot be
// added that the trail redacts and this ships.

export const ORG_EXPORT_JOB = 'org.export'
/// The download stops working this long after the archive was written.
export const ORG_EXPORT_TTL_MS = 7 * 24 * 60 * 60_000
/// A claim nobody finished inside this died with its function; a press may take it back.
const STALE_MS = 15 * 60_000
const PAGE = 2_000

type Model = (typeof Prisma.dmmf.datamodel.models)[number]

/// The tables, in schema order, and how to scope each to one org.
type Exported = { model: Model; where: (orgId: string) => object }

export function exportedModels(): Exported[] {
  return Prisma.dmmf.datamodel.models.flatMap((model): Exported[] => {
    if (model.name === 'Organization') return [{ model, where: (orgId: string) => ({ id: orgId }) }]
    if (model.name === 'StaffUser') {
      return [{ model, where: (orgId: string) => ({ orgMemberships: { some: { orgId } } }) }]
    }
    return model.fields.some((f) => f.name === 'orgId') ? [{ model, where: (orgId: string) => ({ orgId }) }] : []
  })
}

function columns(model: Model) {
  return model.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum')
}

function cell(field: Model['fields'][number], value: unknown): string | number | null {
  if (value == null) return null
  if (isSensitiveField(field.name)) return REDACTED
  if (value instanceof Date) {
    // A `@db.Date` is a calendar day, read as one (CLAUDE.md: no zone touches it).
    return field.nativeType?.[0] === 'Date' ? utcToBusinessDate(value) : value.toISOString()
  }
  if (typeof value === 'number' || typeof value === 'string') return value
  if (typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  if (Prisma.Decimal.isDecimal(value)) return value.toString()
  return JSON.stringify(value)
}

async function tableCsv(model: Model, where: object): Promise<{ csv: string; rows: number }> {
  const cols = columns(model)
  const pk = model.primaryKey?.fields ?? model.fields.filter((f) => f.isId).map((f) => f.name)
  const orderBy = pk.map((name) => ({ [name]: 'asc' as const }))
  const select = Object.fromEntries(cols.map((f) => [f.name, true]))
  const delegate = (prisma as unknown as Record<string, { findMany(args: object): Promise<Record<string, unknown>[]> }>)[
    model.name[0]!.toLowerCase() + model.name.slice(1)
  ]!
  const rows: (string | number | null)[][] = []
  // ponytail: offset paging, quadratic in a table's size; a cursor on the
  // primary key when one org's largest table passes ~100k rows.
  for (let skip = 0; ; skip += PAGE) {
    const page = await delegate.findMany({ where, select, orderBy, skip, take: PAGE })
    for (const row of page) rows.push(cols.map((f) => cell(f, row[f.name])))
    if (page.length < PAGE) break
  }
  return { csv: toCsv(cols.map((f) => f.name), rows), rows: rows.length }
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100)
}

/// Builds the archive for one org. Pure of JobRun state, so a test can read it.
export async function buildOrgExport(orgId: string, now = new Date()): Promise<{ archive: Buffer; manifest: object }> {
  const entries: ZipEntry[] = []
  const tables: { table: string; file: string; rows: number }[] = []
  for (const [index, { model, where }] of exportedModels().entries()) {
    const { csv, rows } = await tableCsv(model, where(orgId))
    // Numbered, so a file listing sorts in schema order.
    const file = `tables/${String(index + 1).padStart(3, '0')}-${model.name}.csv`
    entries.push({ name: file, data: Buffer.from(csv, 'utf8') })
    tables.push({ table: model.name, file, rows })
  }

  const documents = await prisma.document.findMany({
    where: { orgId },
    select: { id: true, fileName: true, storageKey: true },
    orderBy: { id: 'asc' },
  })
  const missing: string[] = []
  for (const document of documents) {
    try {
      entries.push({ name: `documents/${document.id}-${safeName(document.fileName)}`, data: await storage.get(document.storageKey) })
    } catch (error) {
      // A row with no bytes is reported, not fatal; a storage outage is fatal.
      if (!(error instanceof MissingStoredObjectError)) throw error
      missing.push(document.id)
    }
  }

  const [migration] = await prisma.$queryRaw<{ migration_name: string }[]>`
    SELECT migration_name FROM "_prisma_migrations"
    WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1`
  const manifest = {
    orgId,
    generatedAt: now.toISOString(),
    schemaVersion: migration?.migration_name ?? null,
    tables,
    documents: { files: documents.length - missing.length, missingFiles: missing },
    redacted: `Credential columns (password hashes, MFA secrets, tokens, sealed codes, account numbers) read "${REDACTED}".`,
  }
  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') })
  return { archive: zip(entries, now), manifest }
}

export function exportStorageKey(orgId: string, jobRunId: string): string {
  return `org-exports/${orgId}/${jobRunId}.zip`
}

/**
 * Claims today's export for an org: ONE per org per UTC day, by the JobRun
 * unique index (jobType, orgId, '', businessDate). A failed or abandoned run
 * is taken back; a running or finished one is refused, which also caps how
 * often one owner can make the server read every table.
 */
export async function claimOrgExport(
  orgId: string,
  now = new Date(),
): Promise<{ ok: true; id: string } | { ok: false; reason: 'running' | 'done' }> {
  const businessDate = businessDateToUtc(utcToBusinessDate(now))
  try {
    const { id } = await prisma.jobRun.create({
      data: { jobType: ORG_EXPORT_JOB, orgId, propertyId: null, businessDate },
      select: { id: true },
    })
    return { ok: true, id }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
  }
  const retaken = await prisma.jobRun.updateManyAndReturn({
    where: {
      jobType: ORG_EXPORT_JOB,
      orgId,
      propertyId: null,
      businessDate,
      OR: [{ status: 'FAILED' }, { status: 'RUNNING', startedAt: { lt: new Date(now.getTime() - STALE_MS) } }],
    },
    data: { status: 'RUNNING', startedAt: now, error: null, finishedAt: null, result: Prisma.DbNull, attempts: { increment: 1 } },
    select: { id: true },
  })
  if (retaken[0]) return { ok: true, id: retaken[0].id }
  const existing = await prisma.jobRun.findFirst({
    where: { jobType: ORG_EXPORT_JOB, orgId, propertyId: null, businessDate },
    select: { status: true },
  })
  return { ok: false, reason: existing?.status === 'SUCCEEDED' ? 'done' : 'running' }
}

/// Runs a claimed export to completion, recording the outcome on its JobRun.
export async function runOrgExport(jobRunId: string, orgId: string): Promise<void> {
  try {
    const { archive, manifest } = await buildOrgExport(orgId)
    const storageKey = exportStorageKey(orgId, jobRunId)
    await storage.put(storageKey, archive, 'application/zip')
    await prisma.jobRun.update({
      where: { id: jobRunId },
      data: {
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        result: { storageKey, sizeBytes: archive.length, tables: (manifest as { tables: unknown[] }).tables.length },
      },
    })
  } catch (error) {
    await prisma.jobRun.update({
      where: { id: jobRunId },
      data: { status: 'FAILED', finishedAt: new Date(), error: error instanceof Error ? error.message : String(error) },
    })
  }
}
