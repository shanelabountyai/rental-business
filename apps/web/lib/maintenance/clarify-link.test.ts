import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { issueVerifyLink } from '@/lib/portal/verify-link.ts'
import {
  type ClarificationArgs,
  applyClarification,
  issueClarifyLink,
  verifyClarifyLink,
} from './clarify-link.ts'

// The questions a texted-in request never got asked (MAINT-01, MAINT-02,
// R-177).
//
// This token is the only thing standing between a URL in a text message and a
// ticket's description changing, so the tests are about what it REFUSES and
// what the write REFUSES TO OVERWRITE, more than about the happy path.

let entityId: string
let propertyId: string
let unitId: string
let tenantId: string
let otherTenantId: string
let vendorId: string

beforeAll(async () => {
  const stamp = `clink-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '7 Clarify Street',
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
  unitId = unit.id
  const tenant = await prisma.tenant.create({
    // NO EMAIL. The persona this whole item exists for: a phone and nothing
    // else, who cannot sign into an email-only portal at all.
    data: { firstName: 'Dana', lastName: `Texter-${randomUUID().slice(0, 6)}`, email: null },
  })
  tenantId = tenant.id
  const other = await prisma.tenant.create({
    data: { firstName: 'Someone', lastName: `Else-${randomUUID().slice(0, 6)}` },
  })
  otherTenantId = other.id
  const vendor = await prisma.vendor.create({
    data: { name: `Fix-${randomUUID().slice(0, 6)}`, trades: ['PLUMBING'] },
  })
  vendorId = vendor.id
})

afterAll(async () => {
  // Retire rather than delete: AuditLog is append-only by trigger, and
  // `ticket.clarified` entries point at these rows.
  await prisma.tenant.updateMany({
    where: { id: { in: [tenantId, otherTenantId] } },
    data: { active: false },
  })
  await prisma.vendor.updateMany({ where: { id: vendorId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

/// A ticket exactly as `handleInboundSms` leaves one: the tenant's own words,
/// no category, and both booleans defaulted to false because nobody was asked.
async function seedTextedTicket(overrides: Record<string, unknown> = {}) {
  return prisma.ticket.create({
    data: {
      propertyId,
      unitId,
      tenantId,
      source: 'SMS',
      category: 'UNCATEGORIZED',
      description:
        'half the kitchen has no power\n\nSent by text message. The tenant has not answered any clarifying questions, and may not use the portal — reply by text.',
      priority: 'ROUTINE',
      status: 'NEW',
      ...overrides,
    },
  })
}

/// Real option strings, not plausible-looking ones: `validateMaintenanceRequest`
/// refuses a `select` answer outside its own options, so a hand-written
/// fixture that "reads right" tests the refusal instead of the flow.
const ANSWERS: ClarificationArgs = {
  category: 'ELECTRICAL',
  promptAnswers: { what: 'Multiple outlets or lights', extent: 'One room' },
  troubleshooting: { breaker: 'TRIED', gfci: 'DECLINED' },
  entryPermission: true,
  petWarning: false,
  photoDocumentIds: [],
}

describe('verifyClarifyLink', () => {
  it('opens the questions for the tenant it was minted for', async () => {
    const ticket = await seedTextedTicket()
    const { token } = await issueClarifyLink({ ticketId: ticket.id, tenantId })

    const result = await verifyClarifyLink(token)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.ticketId).toBe(ticket.id)
    expect(result.tenantId).toBe(tenantId)
    expect(result.triagedCategory).toBeNull()
    // THE TENANT'S OWN WORDS, and only those. The rest of that description is
    // written at staff, and "may not use the portal — reply by text" is
    // exactly the internal vocabulary D-10 keeps off a tenant screen.
    expect(result.reported).toBe('half the kitchen has no power')
  })

  it('refuses a token minted for a different purpose', async () => {
    // Every purpose's hashes live in one table, so without the purpose check
    // in `checkToken` a verify link's raw token would authenticate here.
    const ticket = await seedTextedTicket()
    const workOrder = await prisma.workOrder.create({
      data: {
        propertyId,
        unitId,
        ticketId: ticket.id,
        vendorId,
        scope: 'Nothing',
        status: 'WORK_COMPLETE',
      },
    })
    const { token } = await issueVerifyLink({ workOrderId: workOrder.id, tenantId, round: 1 })

    expect(await verifyClarifyLink(token)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('refuses a garbage token', async () => {
    expect(await verifyClarifyLink('not-a-token')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('refuses once the ticket has been reassigned to another tenant', async () => {
    // The token names the tenant in its METADATA rather than re-deriving them
    // from the ticket, so a reassignment cannot silently move who is entitled
    // to answer.
    const ticket = await seedTextedTicket()
    const { token } = await issueClarifyLink({ ticketId: ticket.id, tenantId })
    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { tenantId: otherTenantId },
    })

    expect(await verifyClarifyLink(token)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('refuses once somebody is being sent out', async () => {
    // THE GATE THAT MATTERS. Past this point the description is the sheet a
    // vendor is working from, and appending to it after the fact is worse
    // than a dead link.
    const ticket = await seedTextedTicket({ status: 'TRIAGED' })
    const { token } = await issueClarifyLink({ ticketId: ticket.id, tenantId })
    expect((await verifyClarifyLink(token)).ok).toBe(true)

    await prisma.workOrder.create({
      data: { propertyId, unitId, ticketId: ticket.id, scope: 'Chase the dead circuit' },
    })

    expect(await verifyClarifyLink(token)).toEqual({ ok: false, reason: 'in_progress' })
  })

  it('refuses a closed ticket', async () => {
    const ticket = await seedTextedTicket({ status: 'CLOSED' })
    const { token } = await issueClarifyLink({ ticketId: ticket.id, tenantId })
    expect(await verifyClarifyLink(token)).toEqual({ ok: false, reason: 'in_progress' })
  })

  it('revokes the previous link when a new one is issued for the same ticket', async () => {
    const ticket = await seedTextedTicket()
    const first = await issueClarifyLink({ ticketId: ticket.id, tenantId })
    await issueClarifyLink({ ticketId: ticket.id, tenantId })

    // Reported as `answered` rather than as a confusing mismatch: the
    // revocation is a consume, and a consumed token means "somebody has
    // already dealt with this".
    expect(await verifyClarifyLink(first.token)).toEqual({ ok: false, reason: 'answered' })
  })
})

describe('applyClarification', () => {
  it('writes the answers onto the ticket and burns the token', async () => {
    const ticket = await seedTextedTicket()
    const { token } = await issueClarifyLink({ ticketId: ticket.id, tenantId })

    expect(await applyClarification(token, ANSWERS)).toEqual({ ok: true, ticketId: ticket.id })

    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })
    expect(after.category).toBe('ELECTRICAL')
    // Their own words are still the first thing anybody reads.
    expect(after.description.startsWith('half the kitchen has no power')).toBe(true)
    expect(after.description).toContain('Check the breaker panel: Tried this - did not fix it.')
    // The SMS path could only ever default this to false, which is
    // indistinguishable from a tenant who said "come when I am home".
    expect(after.entryPermission).toBe(true)

    // Attributed to the TENANT, not SYSTEM. There is no session here by
    // construction, and `audit()` would have recorded the one person whose
    // answer this is as anonymous (R-032c's own lesson).
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'Ticket', entityId: ticket.id, action: 'ticket.clarified' },
    })
    expect(entry.actorType).toBe('TENANT')
    // `actorRef`, not a dedicated column: AuditLog carries a typed actor plus
    // one free reference, and `actorStaffId` is the only FK.
    expect(entry.actorRef).toBe(tenantId)

    // Single-use: a second Send appends nothing.
    const second = await applyClarification(token, ANSWERS)
    expect('error' in second).toBe(true)
    const twice = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })
    expect(twice.description).toBe(after.description)
  })

  it('never overwrites a category a PM chose during triage', async () => {
    // The tenant's own choice lands in the transcript, where a human can read
    // the disagreement - silently overwriting a deliberate decision would be
    // the worse half of the trade.
    const ticket = await seedTextedTicket({
      category: 'PLUMBING',
      status: 'TRIAGED',
      firstResponseAt: new Date(),
      priority: 'ROUTINE',
    })
    const { token } = await issueClarifyLink({ ticketId: ticket.id, tenantId })

    expect(await applyClarification(token, ANSWERS)).toEqual({ ok: true, ticketId: ticket.id })

    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })
    expect(after.category).toBe('PLUMBING')
    expect(after.description).toContain('Electrical issue.')
    // And a triaged priority is not walked back over by
    // `suggestTicketPriority`'s weak category-plus-habitability signal, which
    // would have raised this to URGENT.
    expect(after.priority).toBe('ROUTINE')
  })

  it('raises the habitability flag from the answers, and never clears one', async () => {
    // The tenant's TEXT said only "the fridge is dead"; what they typed into
    // the free-text prompt is where the habitability language actually
    // arrives. MAINT-02/RISK-05's response clock has to start from it exactly
    // as it would from the portal.
    const raising = await seedTextedTicket({ description: 'fridge stopped working' })
    const { token } = await issueClarifyLink({ ticketId: raising.id, tenantId })
    await applyClarification(token, {
      ...ANSWERS,
      category: 'APPLIANCE',
      promptAnswers: {
        appliance: 'Refrigerator',
        symptom: 'It leaked all week and now there is mold behind it',
      },
      troubleshooting: {},
    })
    expect(
      (await prisma.ticket.findUniqueOrThrow({ where: { id: raising.id } })).habitabilityFlag,
    ).toBe(true)

    // It starts a legally significant response clock (MAINT-02, RISK-05), so
    // nothing a tenant answers later is grounds for stopping one.
    const flagged = await seedTextedTicket({ habitabilityFlag: true })
    const second = await issueClarifyLink({ ticketId: flagged.id, tenantId })
    await applyClarification(second.token, ANSWERS)
    expect(
      (await prisma.ticket.findUniqueOrThrow({ where: { id: flagged.id } })).habitabilityFlag,
    ).toBe(true)
  })

  it('refuses answers that skip a script step the tenant was shown', async () => {
    // MAINT-01's "logging tried/declined before dispatch is allowed" is a
    // property of the dispatch, not of the channel - the same gate the portal
    // wizard runs, through the same `validateMaintenanceRequest`.
    const ticket = await seedTextedTicket()
    const { token } = await issueClarifyLink({ ticketId: ticket.id, tenantId })

    const result = await applyClarification(token, { ...ANSWERS, troubleshooting: {} })
    expect('fieldErrors' in result && result.fieldErrors?.['troubleshooting.breaker']).toBeTruthy()

    // And the refusal did NOT burn the token - a tenant who missed a question
    // must be able to answer it.
    expect((await verifyClarifyLink(token)).ok).toBe(true)
  })

  it('refuses a token whose ticket has moved on since the page rendered', async () => {
    // The page and the submit are two requests. Re-verifying inside the write
    // is what stops the second one trading on the first one's authorization
    // (D-45).
    const ticket = await seedTextedTicket()
    const { token } = await issueClarifyLink({ ticketId: ticket.id, tenantId })
    await prisma.workOrder.create({
      data: { propertyId, unitId, ticketId: ticket.id, scope: 'Already dispatched' },
    })

    const result = await applyClarification(token, ANSWERS)
    expect('error' in result).toBe(true)
    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })
    expect(after.category).toBe('UNCATEGORIZED')
  })
})
