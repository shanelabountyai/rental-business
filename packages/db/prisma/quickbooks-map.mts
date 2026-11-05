// db:quickbooks-map - the onboarding step that tells the nightly sync which
// account and which Class or Location each thing posts to (R-282a, D-397).
// There is deliberately no screen: Shane does this per customer.
//
//   npm run db:quickbooks-map -- --entity <legalEntityId>
//     prints a template: every account key with PRD 09's default name, and
//     every property of the entity, with any mapping already stored
//   npm run db:quickbooks-map -- --entity <legalEntityId> --file mapping.json
//     upserts it; the file has the template's shape, ids filled in:
//     { "accounts":   { "RENTAL_INCOME": { "id": "79", "name": "Rental Income" } },
//       "properties": { "<propertyId>":  { "id": "5000000000000123", "name": "310 Magnolia" } } }
//
// The ids are QuickBooks' own (Account.Id, Class.Id or Location.Id per the
// connection's property field). Anything left out stays unmapped, and the
// sync blocks only when a night's entries actually need it.

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { ACCOUNT_DEFAULTS } from '../../core/accounting/index.ts'
import { recordAudit } from '../../core/audit/index.ts'
import { prisma } from '../index.ts'

type Ref = { id: string; name: string }
type MappingFile = { accounts?: Record<string, Ref>; properties?: Record<string, Ref> }

const { values } = parseArgs({ options: { entity: { type: 'string' }, file: { type: 'string' } } })
if (!values.entity) throw new Error('--entity <legalEntityId> is required.')

const connection = await prisma.quickBooksConnection.findUnique({
  where: { legalEntityId: values.entity },
  include: { mappings: true, legalEntity: { select: { properties: { select: { id: true, name: true } } } } },
})
if (!connection) throw new Error('That entity has no QuickBooks connection. Connect it at /money/quickbooks first.')
const properties = connection.legalEntity.properties
const stored = (kind: 'ACCOUNT' | 'PROPERTY', key: string) =>
  connection.mappings.find((m) => m.kind === kind && m.platformKey === key)

if (!values.file) {
  const ref = (kind: 'ACCOUNT' | 'PROPERTY', key: string, name: string) => {
    const row = stored(kind, key)
    return { id: row?.externalId ?? '', name: row?.externalName ?? name }
  }
  const template = {
    propertyField: connection.propertyField,
    accounts: Object.fromEntries(Object.entries(ACCOUNT_DEFAULTS).map(([key, name]) => [key, ref('ACCOUNT', key, name)])),
    properties: Object.fromEntries(properties.map((p) => [p.id, ref('PROPERTY', p.id, p.name)])),
  }
  console.log(JSON.stringify(template, null, 2))
  process.exit(0)
}

const input = JSON.parse(readFileSync(values.file, 'utf8')) as MappingFile
const rows: { kind: 'ACCOUNT' | 'PROPERTY'; platformKey: string; ref: Ref }[] = []
for (const [key, ref] of Object.entries(input.accounts ?? {})) {
  if (!(key in ACCOUNT_DEFAULTS)) throw new Error(`Unknown account key ${key}. Known: ${Object.keys(ACCOUNT_DEFAULTS).join(', ')}.`)
  rows.push({ kind: 'ACCOUNT', platformKey: key, ref })
}
for (const [propertyId, ref] of Object.entries(input.properties ?? {})) {
  if (!properties.some((p) => p.id === propertyId)) throw new Error(`Property ${propertyId} does not belong to this entity.`)
  rows.push({ kind: 'PROPERTY', platformKey: propertyId, ref })
}
// An empty id is the template's blank, not a mapping.
const filled = rows.filter((row) => row.ref?.id?.trim())
for (const row of filled) {
  if (typeof row.ref.name !== 'string' || !row.ref.name.trim()) throw new Error(`${row.platformKey} needs a name.`)
}

await prisma.$transaction(async (tx) => {
  for (const { kind, platformKey, ref } of filled) {
    const data = { externalId: ref.id.trim(), externalName: ref.name.trim() }
    await tx.quickBooksMapping.upsert({
      where: { connectionId_kind_platformKey: { connectionId: connection.id, kind, platformKey } },
      create: { orgId: connection.orgId, connectionId: connection.id, kind, platformKey, ...data },
      update: data,
    })
  }
  await recordAudit(tx, {
    actor: { type: 'SYSTEM', ref: 'db:quickbooks-map' },
    action: 'integration.mapped',
    entityType: 'QuickBooksConnection',
    entityId: connection.id,
    orgId: connection.orgId,
    before: { mappings: connection.mappings.map((m) => `${m.kind}:${m.platformKey}=${m.externalId}`) },
    after: { mappings: filled.map((r) => `${r.kind}:${r.platformKey}=${r.ref.id.trim()}`) },
  })
})
console.log(`Mapped ${filled.length} item(s) for ${values.entity}.`)
await prisma.$disconnect()
