import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { PDFDocument } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderNoticePdf } from './pdf.ts'

// Notice delivery proof, against a real database (COMM-02, R-051).
//
// ==========================================================================
// WHAT THIS FILE TESTS, AND WHY IT TESTS THE DATABASE DIRECTLY.
//
// The guarantees this item is built on are not application logic - they are a
// trigger and three CHECK constraints. "A POSTED_WITH_PHOTO row cannot exist
// without a photograph" is only true if Postgres says so; an assertion
// against a TypeScript function that happens to check the same thing proves
// the function, not the guarantee, and the guarantee is what an eviction
// rests on.
//
// The server actions themselves are covered by e2e rather than here:
// `recordNoticeService` imports `lib/audit/index.ts`, which resolves the
// actor from an Auth.js session and cannot load under Vitest - the same
// boundary R-047 documented when it reached for an injected AuditWriter.
// ==========================================================================

let propertyId: string
let leaseId: string
let noticeId: string
let entityId: string
let tenantId: string

beforeAll(async () => {
  const stamp = `notice-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '4 Notice Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${randomUUID().slice(0, 6)}`, status: 'OCCUPIED' },
  })
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Nadia', lastName: `Notice-${randomUUID().slice(0, 6)}` },
  })
  tenantId = tenant.id
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
    },
  })
  leaseId = lease.id
  await prisma.leaseTenant.create({ data: { leaseId, tenantId, isPrimary: true } })

  const notice = await prisma.notice.create({
    data: {
      propertyId,
      leaseId,
      type: 'NOTICE_TO_VACATE',
      addressOfRecord: '4 Notice Way, Houston, TX 77002',
      bodyText: 'You must vacate within three days.\n\nThe reason is non-payment.',
    },
  })
  noticeId = notice.id
})

afterAll(async () => {
  // NoticeDelivery is append-only and its foreign keys are RESTRICT, so
  // nothing a service record points at can be deleted - the Notice, the
  // lease, the property and the tenant all stay. That is the product working:
  // proof of service outlives the fixtures that produced it. Only the roots
  // are deactivated.
  await prisma.tenant.updateMany({ where: { id: tenantId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.$disconnect()
})

async function delivery(overrides: Record<string, unknown> = {}) {
  return prisma.noticeDelivery.create({
    data: {
      noticeId,
      method: 'PERSONAL',
      servedAt: new Date('2026-08-16T15:00:00Z'),
      ...overrides,
    } as never,
  })
}

describe('NoticeDelivery CHECK constraints — the shape each method promises', () => {
  it('REFUSES a posted notice with no photograph', async () => {
    // The enum value is literally named POSTED_WITH_PHOTO. A row claiming it
    // without a photograph is not a weaker record, it is a false one.
    await expect(delivery({ method: 'POSTED_WITH_PHOTO' })).rejects.toThrow()
  })

  it('REFUSES certified mail with no article number', async () => {
    // Untrackable certified mail produces no delivery scan and proves nothing.
    await expect(delivery({ method: 'CERTIFIED_MAIL' })).rejects.toThrow()
  })

  it('accepts certified mail once the article number is there', async () => {
    const row = await delivery({
      method: 'CERTIFIED_MAIL',
      trackingNumber: '9407 1000 0000 0000 0000 00',
      carrier: 'USPS',
    })
    expect(row.trackingNumber).toContain('9407')
  })

  it('refuses a read receipt on service that did not happen in the portal', async () => {
    await expect(
      delivery({ method: 'PERSONAL', readAt: new Date('2026-08-16T16:00:00Z') }),
    ).rejects.toThrow()
  })
})

describe('NoticeDelivery is append-only, with exactly one exception', () => {
  it('REFUSES a DELETE', async () => {
    const row = await delivery()
    await expect(prisma.noticeDelivery.delete({ where: { id: row.id } })).rejects.toThrow()
  })

  it('REFUSES an edit to when or how it was served', async () => {
    // If "when did we serve it, and how" can be edited afterwards, it is not
    // proof of anything.
    const row = await delivery()
    await expect(
      prisma.noticeDelivery.update({
        where: { id: row.id },
        data: { servedAt: new Date('2020-01-01T00:00:00Z') },
      }),
    ).rejects.toThrow()
    await expect(
      prisma.noticeDelivery.update({ where: { id: row.id }, data: { note: 'revised' } }),
    ).rejects.toThrow()
  })

  it('ALLOWS readAt to be set once, and refuses to move it afterwards', async () => {
    const row = await delivery({ method: 'PORTAL' })
    expect(row.readAt).toBeNull()

    const first = new Date('2026-08-17T09:00:00Z')
    const read = await prisma.noticeDelivery.update({
      where: { id: row.id },
      data: { readAt: first },
    })
    expect(read.readAt?.toISOString()).toBe(first.toISOString())

    // A second view does not overwrite the first: the evidence is when they
    // FIRST read it.
    await expect(
      prisma.noticeDelivery.update({
        where: { id: row.id },
        data: { readAt: new Date('2026-08-18T09:00:00Z') },
      }),
    ).rejects.toThrow()
  })

  it('refuses to smuggle another change in alongside readAt', async () => {
    const row = await delivery({ method: 'PORTAL' })
    await expect(
      prisma.noticeDelivery.update({
        where: { id: row.id },
        data: { readAt: new Date('2026-08-17T09:00:00Z'), note: 'and this' },
      }),
    ).rejects.toThrow()
  })
})

describe('one notice, several service events', () => {
  it('records POSTED AND MAILED against the same notice — the reason the table exists', async () => {
    // Several states require a notice to vacate be both posted and mailed,
    // each half with its own proof. The single `Notice.serviceMethod` column
    // this replaces could record only one of them.
    const posted = await prisma.document.create({
      data: {
        propertyId,
        type: 'NOTICE_PROOF',
        fileName: 'door.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1234,
        storageKey: `test/${randomUUID()}.jpg`,
        sha256: randomUUID().replace(/-/g, ''),
        capturedAt: new Date('2026-08-16T14:55:00Z'),
      },
    })

    const notice = await prisma.notice.create({
      data: {
        propertyId,
        leaseId,
        type: 'NOTICE_TO_VACATE',
        addressOfRecord: '4 Notice Way',
      },
    })
    await prisma.noticeDelivery.create({
      data: {
        noticeId: notice.id,
        method: 'POSTED_WITH_PHOTO',
        servedAt: new Date('2026-08-16T15:00:00Z'),
        proofDocumentId: posted.id,
        permittedByJurisdiction: true,
      },
    })
    await prisma.noticeDelivery.create({
      data: {
        noticeId: notice.id,
        method: 'CERTIFIED_MAIL',
        servedAt: new Date('2026-08-16T16:30:00Z'),
        trackingNumber: '9407 1000 0000 0000 0000 11',
        permittedByJurisdiction: true,
      },
    })

    const rows = await prisma.noticeDelivery.findMany({
      where: { noticeId: notice.id },
      orderBy: { servedAt: 'asc' },
      include: { proofDocument: true },
    })
    expect(rows.map((r) => r.method)).toEqual(['POSTED_WITH_PHOTO', 'CERTIFIED_MAIL'])
    // The photo's OWN timestamp survives - a picture of a door proves nothing
    // without when it was taken.
    expect(rows[0].proofDocument?.capturedAt).not.toBeNull()
    expect(rows[1].trackingNumber).toContain('9407')
  })

  it('cannot delete the photograph a service record depends on', async () => {
    const row = await prisma.noticeDelivery.findFirstOrThrow({
      where: { proofDocumentId: { not: null } },
    })
    await expect(
      prisma.document.delete({ where: { id: row.proofDocumentId! } }),
    ).rejects.toThrow()
  })
})

describe('renderNoticePdf', () => {
  it('produces a real PDF', async () => {
    const bytes = await renderNoticePdf({
      noticeType: 'NOTICE_TO_VACATE',
      addressOfRecord: '4 Notice Way, Houston, TX 77002',
      propertyName: 'Notice House',
      unitName: 'Main house',
      tenantNames: ['Nadia Notice'],
      bodyText: 'You must vacate within three days.\n\nThe reason is non-payment.',
      generatedOn: '2026-08-16',
      citation: 'Tex. Prop. Code §24.005',
    })
    // The magic number, not just "some bytes came back".
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-')
    expect(bytes.byteLength).toBeGreaterThan(500)
    // Pinned at one page, so the multi-page assertion below means something.
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1)
  })

  it('paginates a body far longer than one page rather than dropping it', async () => {
    // pdf-lib draws at coordinates and does not paginate; the renderer does.
    // A silently-clipped notice is the failure mode that matters, because it
    // looks fine until somebody reads page two in court.
    const long = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} of the notice.`).join(
      '\n\n',
    )
    const bytes = await renderNoticePdf({
      noticeType: 'LEASE_VIOLATION',
      addressOfRecord: '4 Notice Way',
      propertyName: 'Notice House',
      tenantNames: ['Nadia Notice'],
      bodyText: long,
      generatedOn: '2026-08-16',
    })
    // Read the page count back out of the real document rather than
    // grepping the bytes - pdf-lib compresses object streams, so `/Type
    // /Page` is not literal text in the output and a regex against it
    // passes or fails for reasons that have nothing to do with pagination.
    const reloaded = await PDFDocument.load(bytes)
    expect(reloaded.getPageCount()).toBeGreaterThan(1)
  })

  it('wraps a word longer than the line rather than throwing', async () => {
    const bytes = await renderNoticePdf({
      noticeType: 'OTHER',
      addressOfRecord: 'x',
      propertyName: 'y',
      tenantNames: [],
      bodyText: 'A'.repeat(400),
      generatedOn: '2026-08-16',
    })
    expect(bytes.byteLength).toBeGreaterThan(500)
  })
})
