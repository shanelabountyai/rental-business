import { randomUUID } from 'node:crypto'
import { tenantCanSeeDocument } from '@rental/core/portal'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  getTenantDocument,
  getTenantHome,
  getTenantThread,
  listTenantDocuments,
  listTenantThreads,
  listTenantUpdates,
} from './queries.ts'

// DOC-03's "verified by permission tests", against a real database.
//
// The rule itself is unit-tested pure in packages/core/portal. What THIS file
// proves is that the SQL agrees with it - because the rule exists twice, once
// as a predicate and once as a `where` clause, and two expressions of one rule
// is exactly the shape that drifts apart. The last test walks every document
// in the fixture and asserts the two answers match, one by one.

let entityId: string
let propertyId: string
let myLeaseId: string
let theirLeaseId: string
let meId: string
let themId: string

const documentIds: string[] = []
const threadIds: string[] = []

async function makeDocument(
  data: Partial<{
    tenantId: string
    leaseId: string
    deletedAt: Date
    type: string
    fileName: string
  }> = {},
) {
  const document = await prisma.document.create({
    data: {
      propertyId,
      tenantId: data.tenantId ?? null,
      leaseId: data.leaseId ?? null,
      deletedAt: data.deletedAt ?? null,
      type: data.type ?? 'OTHER',
      fileName: data.fileName ?? `${randomUUID().slice(0, 8)}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: 100,
      storageKey: `test/${randomUUID()}`,
    },
  })
  documentIds.push(document.id)
  return document
}

beforeAll(async () => {
  const stamp = `portal-${Date.now()}`
  const entity = await prisma.legalEntity.create({
    data: { name: stamp, type: 'LLC' },
  })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '1 Test St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'DUPLEX',
      active: true,
    },
  })
  propertyId = property.id

  const makeTenancy = async (label: string) => {
    const tenant = await prisma.tenant.create({
      data: { firstName: 'T', lastName: `${label}-${randomUUID().slice(0, 6)}` },
    })
    const unit = await prisma.unit.create({
      data: {
        propertyId,
        name: `U-${randomUUID().slice(0, 6)}`,
        status: 'OCCUPIED',
      },
    })
    const lease = await prisma.lease.create({
      data: {
        propertyId,
        unitId: unit.id,
        status: 'ACTIVE',
        startsOn: new Date('2026-01-01'),
        rentCents: 150_000,
      },
    })
    await prisma.leaseTenant.create({
      data: { leaseId: lease.id, tenantId: tenant.id },
    })
    return { tenantId: tenant.id, leaseId: lease.id }
  }

  const mine = await makeTenancy('me')
  const theirs = await makeTenancy('them')
  meId = mine.tenantId
  myLeaseId = mine.leaseId
  themId = theirs.tenantId
  theirLeaseId = theirs.leaseId
})

afterAll(async () => {
  await prisma.document.deleteMany({ where: { id: { in: documentIds } } })
  // Threads may carry append-only Messages, so they are left in place and the
  // property is deactivated instead - the same wall every other spec hits.
  await prisma.property.updateMany({
    where: { id: propertyId },
    data: { active: false },
  })
  await prisma.tenant.updateMany({
    where: { id: { in: [meId, themId] } },
    data: { active: false },
  })
  await prisma.$disconnect()
})

function myScope() {
  return { tenantId: meId, leaseIds: [myLeaseId] }
}

describe('a tenant sees only their own papers (DOC-03)', () => {
  it('lists a document naming them and one on their lease', async () => {
    const named = await makeDocument({ tenantId: meId, fileName: 'mine.pdf' })
    const onLease = await makeDocument({
      leaseId: myLeaseId,
      fileName: 'lease.pdf',
    })

    const visible = await listTenantDocuments(myScope())
    const ids = visible.map((d) => d.id)
    expect(ids).toContain(named.id)
    expect(ids).toContain(onLease.id)
  })

  it('never lists another tenant’s document at the same address', async () => {
    // A duplex, or the same house after a turnover. This is the leak that
    // matters most and the reason the rule is an allow-list.
    const theirNamed = await makeDocument({ tenantId: themId })
    const theirLease = await makeDocument({ leaseId: theirLeaseId })

    const ids = (await listTenantDocuments(myScope())).map((d) => d.id)
    expect(ids).not.toContain(theirNamed.id)
    expect(ids).not.toContain(theirLease.id)
  })

  it('never lists a landlord document that only names the property', async () => {
    // The deed, the mortgage note, insurance, HOA papers, warranties - all of
    // them carry a propertyId and nothing else.
    const deed = await makeDocument({ type: 'DEED', fileName: 'deed.pdf' })
    const mortgage = await makeDocument({ type: 'MORTGAGE_DOC' })

    const ids = (await listTenantDocuments(myScope())).map((d) => d.id)
    expect(ids).not.toContain(deed.id)
    expect(ids).not.toContain(mortgage.id)
  })

  it('never lists a soft-deleted document', async () => {
    const deleted = await makeDocument({
      tenantId: meId,
      deletedAt: new Date(),
    })
    const ids = (await listTenantDocuments(myScope())).map((d) => d.id)
    expect(ids).not.toContain(deleted.id)
  })

  it('refuses a direct fetch of another tenant’s document by id', async () => {
    // The list being correct is not enough - the id is guessable and the
    // download route takes one. Null, not an error, so "not yours" and "does
    // not exist" are indistinguishable.
    const theirs = await makeDocument({ tenantId: themId })
    expect(await getTenantDocument(theirs.id, myScope())).toBeNull()
  })

  it('allows a direct fetch of their own document by id', async () => {
    const mine = await makeDocument({ leaseId: myLeaseId })
    const found = await getTenantDocument(mine.id, myScope())
    expect(found?.id).toBe(mine.id)
  })

  it('shows a tenant with no lease nothing but their own named documents', async () => {
    const orphanScope = { tenantId: meId, leaseIds: [] as string[] }
    const named = await makeDocument({ tenantId: meId })
    const onLease = await makeDocument({ leaseId: myLeaseId })

    const ids = (await listTenantDocuments(orphanScope)).map((d) => d.id)
    expect(ids).toContain(named.id)
    // An empty leaseIds array must match NOTHING - not every document whose
    // leaseId happens to be null, which is every landlord document there is.
    expect(ids).not.toContain(onLease.id)
  })

  it('agrees with the pure rule on every document in the fixture', async () => {
    // The drift check. The predicate and the `where` clause are two
    // expressions of one rule; this walks the whole fixture and asserts they
    // give the same answer for every row, including the landlord's.
    const scope = myScope()
    const all = await prisma.document.findMany({
      where: { id: { in: documentIds } },
    })
    const visibleIds = new Set(
      (await listTenantDocuments(scope)).map((d) => d.id),
    )
    expect(all.length).toBeGreaterThan(5)

    for (const document of all) {
      expect(
        visibleIds.has(document.id),
        `${document.fileName} (tenantId=${document.tenantId}, leaseId=${document.leaseId}, deleted=${Boolean(document.deletedAt)})`,
      ).toBe(tenantCanSeeDocument(document, scope))
    }
  })
})

describe('the rest of the portal is scoped the same way', () => {
  it('shows the tenant their own home', async () => {
    const home = await getTenantHome(myScope())
    expect(home?.id).toBe(myLeaseId)
  })

  it('shows nothing to a tenant with no lease', async () => {
    expect(await getTenantHome({ tenantId: meId, leaseIds: [] })).toBeNull()
  })

  it('never shows another tenant’s conversation', async () => {
    const theirThread = await prisma.thread.create({
      data: {
        key: `tenant:${themId}:property:${propertyId}`,
        propertyId,
        tenantId: themId,
      },
    })
    threadIds.push(theirThread.id)

    const mine = await listTenantThreads(myScope())
    expect(mine.map((t) => t.id)).not.toContain(theirThread.id)
    expect(await getTenantThread(theirThread.id, myScope())).toBeNull()
  })

  it('shows only delivered PORTAL updates, not suppressed ones', async () => {
    const delivered = await prisma.notification.create({
      data: {
        idempotencyKey: `portal-test:${randomUUID()}`,
        category: 'rent_reminder',
        channel: 'PORTAL',
        recipientType: 'TENANT',
        recipientId: meId,
        toAddress: meId,
        templateKey: 'test',
        subject: 'Delivered one',
        body: 'body',
        propertyId,
        delivery: { create: { status: 'DELIVERED' } },
      },
    })
    const suppressed = await prisma.notification.create({
      data: {
        idempotencyKey: `portal-test:${randomUUID()}`,
        category: 'rent_reminder',
        channel: 'PORTAL',
        recipientType: 'TENANT',
        recipientId: meId,
        toAddress: meId,
        templateKey: 'test',
        subject: 'Suppressed one',
        body: 'body',
        propertyId,
        delivery: {
          create: { status: 'SUPPRESSED', suppressedReason: 'kill_switch' },
        },
      },
    })

    const updates = await listTenantUpdates(myScope())
    const ids = updates.map((u) => u.id)
    expect(ids).toContain(delivered.id)
    // A suppressed notification is a record of a decision NOT to send. The
    // tenant was never told, so showing it here would be telling them.
    expect(ids).not.toContain(suppressed.id)
  })

  it('never shows another tenant’s updates', async () => {
    const theirs = await prisma.notification.create({
      data: {
        idempotencyKey: `portal-test:${randomUUID()}`,
        category: 'rent_reminder',
        channel: 'PORTAL',
        recipientType: 'TENANT',
        recipientId: themId,
        toAddress: themId,
        templateKey: 'test',
        subject: 'Not yours',
        body: 'body',
        propertyId,
        delivery: { create: { status: 'DELIVERED' } },
      },
    })
    const ids = (await listTenantUpdates(myScope())).map((u) => u.id)
    expect(ids).not.toContain(theirs.id)
  })
})
