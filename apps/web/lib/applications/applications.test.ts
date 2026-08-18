import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { issueToken } from '@/lib/auth/store.ts'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'
import {
  inviteCoApplicant,
  startApplicationFeePayment,
  submitApplicantForm,
  uploadApplicationDocument,
} from './actions.ts'
import { completeApplicantIfDone, projectApplicationFeeEvent } from './fee-webhook.ts'
import { applicationLinkStatus } from './link.ts'
import { applicationForProspect, documentsForApplicant, householdFor } from './queries.ts'

// The database half of LEASE-03 (R-059) - everything EXCEPT inviteToApply
// (staff-actions.ts, session-dependent via requirePermission/audit()) and
// the fee payment's client-side Elements confirmation (a cross-origin
// iframe, same reasoning AutopayPanel's own header states). Both are
// covered by e2e instead. Applications are seeded directly here, bypassing
// inviteToApply, the same choice prospects.test.ts makes for the identical
// wall - see that file's own header.

vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))

function scopeOf(propertyIds: string[]): ResolvedScope {
  return {
    selection: { kind: 'all' },
    availableEntities: [],
    availableProperties: [],
    propertyIds,
    switchable: false,
  }
}

let entityId: string
let propertyId: string
let unitId: string
let listingId: string
const prospectIds: string[] = []
const applicationIds: string[] = []

beforeAll(async () => {
  const stamp = `application-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '90 Application Ave',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${randomUUID().slice(0, 6)}`, status: 'VACANT' },
  })
  unitId = unit.id
  const listing = await prisma.listing.create({
    data: {
      propertyId,
      unitId,
      status: 'PUBLISHED',
      rentCents: 150_000,
      applicationFeeCents: 5_000,
      availableOn: new Date('2026-09-01'),
      publishedAt: new Date(),
    },
  })
  listingId = listing.id
})

afterAll(async () => {
  await prisma.document.deleteMany({ where: { propertyId } })
  await prisma.applicant.deleteMany({ where: { application: { propertyId } } })
  await prisma.application.deleteMany({ where: { id: { in: applicationIds } } })
  await prisma.prospect.deleteMany({ where: { id: { in: prospectIds } } })
  await prisma.listing.deleteMany({ where: { id: listingId } })
  await prisma.unit.deleteMany({ where: { id: unitId } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

async function seedApplication(feeCents: number | null) {
  const prospect = await prisma.prospect.create({
    data: {
      propertyId,
      listingId,
      firstName: 'Jordan',
      lastName: `Blake-${randomUUID().slice(0, 6)}`,
      email: `jordan-${randomUUID().slice(0, 8)}@example.test`,
      source: 'direct',
      status: 'PRE_SCREENED',
    },
  })
  prospectIds.push(prospect.id)

  const application = await prisma.application.create({
    data: { propertyId, listingId, prospectId: prospect.id },
  })
  applicationIds.push(application.id)

  const lead = await prisma.applicant.create({
    data: {
      applicationId: application.id,
      isLead: true,
      firstName: prospect.firstName,
      lastName: prospect.lastName,
      email: prospect.email,
      feeCents,
    },
  })

  const issued = await issueToken('APPLICATION_LINK', { type: 'Applicant', id: lead.id })
  return { prospect, application, lead, token: issued.token }
}

const validFormData = () => {
  const formData = new FormData()
  formData.set('intent', 'submit')
  formData.set('firstName', 'Jordan')
  formData.set('lastName', 'Blake')
  formData.set('email', 'jordan@example.test')
  formData.set('dateOfBirth', '1990-01-01')
  formData.set('currentAddressLine1', '12 Main St')
  formData.set('currentCity', 'Houston')
  formData.set('currentState', 'TX')
  formData.set('currentPostalCode', '77002')
  formData.set('monthsAtCurrentAddress', '24')
  formData.set('monthlyIncome', '5000')
  return formData
}

describe('applicationLinkStatus', () => {
  it('accepts a valid token and stays live after a second read - multi-use', async () => {
    const { token } = await seedApplication(null)
    const first = await applicationLinkStatus(token)
    expect(first.ok).toBe(true)
    const second = await applicationLinkStatus(token)
    expect(second.ok).toBe(true)
  })

  it('rejects a forged token', async () => {
    const status = await applicationLinkStatus('not-a-real-token')
    expect(status.ok).toBe(false)
    if (!status.ok) expect(status.reason).toBe('not_found')
  })
})

describe('submitApplicantForm', () => {
  it('saves progress with no validation on intent=save', async () => {
    const { token, lead } = await seedApplication(null)
    const formData = new FormData()
    formData.set('intent', 'save')
    formData.set('firstName', 'Jordan')
    formData.set('lastName', 'Blake')
    // Nothing else filled in - must not error.
    const result = await submitApplicantForm(token, {}, formData)
    expect(result.error).toBeUndefined()

    const after = await prisma.applicant.findUniqueOrThrow({ where: { id: lead.id } })
    expect(after.firstName).toBe('Jordan')
    expect(after.formSubmittedAt).toBeNull()
  })

  it('rejects an incomplete submit but keeps the entered fields', async () => {
    const { token, lead } = await seedApplication(null)
    const formData = new FormData()
    formData.set('intent', 'submit')
    formData.set('firstName', 'Jordan')
    formData.set('lastName', 'Blake')
    // No DOB, no address, no income.
    const result = await submitApplicantForm(token, {}, formData)
    expect(result.error).toBeTruthy()

    const after = await prisma.applicant.findUniqueOrThrow({ where: { id: lead.id } })
    expect(after.firstName).toBe('Jordan')
    expect(after.formSubmittedAt).toBeNull()
  })

  it('completes immediately when no fee is due - and flips the Prospect and Application too', async () => {
    const { token, lead, application, prospect } = await seedApplication(null)
    const result = await submitApplicantForm(token, {}, validFormData())
    expect(result.error).toBeUndefined()

    const applicant = await prisma.applicant.findUniqueOrThrow({ where: { id: lead.id } })
    expect(applicant.formSubmittedAt).not.toBeNull()
    expect(applicant.completedAt).not.toBeNull()

    const app = await prisma.application.findUniqueOrThrow({ where: { id: application.id } })
    expect(app.completedAt).not.toBeNull()

    const updatedProspect = await prisma.prospect.findUniqueOrThrow({
      where: { id: prospect.id },
    })
    expect(updatedProspect.status).toBe('APPLIED')

    const audited = await prisma.auditLog.findFirst({
      where: { action: 'application.completed', entityId: application.id },
    })
    expect(audited?.actorType).toBe('SYSTEM')
  })

  it('submits but does NOT complete while a fee is still due', async () => {
    const { token, lead } = await seedApplication(5_000)
    const result = await submitApplicantForm(token, {}, validFormData())
    expect(result.error).toBeUndefined()

    const applicant = await prisma.applicant.findUniqueOrThrow({ where: { id: lead.id } })
    expect(applicant.formSubmittedAt).not.toBeNull()
    expect(applicant.completedAt).toBeNull()
  })
})

describe('inviteCoApplicant', () => {
  it('the lead adds a co-applicant, who gets their own link', async () => {
    const { token, application } = await seedApplication(null)
    const formData = new FormData()
    formData.set('firstName', 'Sam')
    formData.set('lastName', 'Rivera')
    formData.set('email', 'sam@example.test')

    const result = await inviteCoApplicant(token, {}, formData)
    expect(result.error).toBeUndefined()

    const applicants = await prisma.applicant.findMany({
      where: { applicationId: application.id },
    })
    expect(applicants).toHaveLength(2)
    const coApplicant = applicants.find((a) => !a.isLead)
    expect(coApplicant?.firstName).toBe('Sam')
    expect(coApplicant?.feeCents).toBeNull()

    const notification = await prisma.notification.findFirst({
      where: { recipientType: 'APPLICANT', recipientId: coApplicant!.id },
    })
    expect(notification?.templateKey).toBe('application.coapplicant_invite')
  })

  it('refuses when a non-lead applicant tries to invite someone', async () => {
    const { application } = await seedApplication(null)
    const coApplicant = await prisma.applicant.create({
      data: { applicationId: application.id, isLead: false, firstName: 'Sam', lastName: 'Rivera' },
    })
    const issued = await issueToken('APPLICATION_LINK', { type: 'Applicant', id: coApplicant.id })

    const formData = new FormData()
    formData.set('firstName', 'Alex')
    formData.set('lastName', 'Nguyen')
    formData.set('email', 'alex@example.test')

    const result = await inviteCoApplicant(issued.token, {}, formData)
    expect(result.error).toBeTruthy()

    const applicants = await prisma.applicant.findMany({
      where: { applicationId: application.id },
    })
    expect(applicants).toHaveLength(2)
  })
})

describe('uploadApplicationDocument', () => {
  it('attaches a document to the uploading applicant', async () => {
    const { token, lead } = await seedApplication(null)
    const formData = new FormData()
    const file = new File([new Uint8Array([1, 2, 3])], 'id-front.jpg', { type: 'image/jpeg' })
    formData.set('file', file)

    const result = await uploadApplicationDocument(token, {}, formData)
    expect(result.error).toBeUndefined()

    const documents = await documentsForApplicant(lead.id)
    expect(documents).toHaveLength(1)
    expect(documents[0]!.fileName).toBe('id-front.jpg')
  })
})

describe('startApplicationFeePayment', () => {
  it('refuses when no fee is due', async () => {
    const { token } = await seedApplication(null)
    const result = await startApplicationFeePayment(token)
    expect(result.error).toBeTruthy()
    expect(result.clientSecret).toBeUndefined()
  })

  it('mints a Stripe customer and a client secret when a fee is due', async () => {
    const { token, lead } = await seedApplication(5_000)
    const result = await startApplicationFeePayment(token)
    expect(result.error).toBeUndefined()
    expect(result.clientSecret).toBeTruthy()

    const applicant = await prisma.applicant.findUniqueOrThrow({ where: { id: lead.id } })
    expect(applicant.stripeCustomerId).toBeTruthy()
  })
})

describe('projectApplicationFeeEvent (the webhook half)', () => {
  it('marks the fee paid, notifies, and completes the applicant if the form was already submitted', async () => {
    const { token, lead, application, prospect } = await seedApplication(5_000)
    await submitApplicantForm(token, {}, validFormData())

    const withCustomer = await startApplicationFeePayment(token)
    expect(withCustomer.clientSecret).toBeTruthy()
    const applicantWithCustomer = await prisma.applicant.findUniqueOrThrow({
      where: { id: lead.id },
    })

    const detail = await projectApplicationFeeEvent(
      { id: lead.id, applicationId: application.id, firstName: lead.firstName },
      {
        kind: 'payment_succeeded',
        stripeObjectId: 'pi_test',
        stripeCustomerId: applicantWithCustomer.stripeCustomerId,
        stripeInvoiceId: null,
        stripePaymentIntentId: 'pi_test',
        rail: 'CARD',
        amountCents: 5_000,
        occurredAt: new Date(),
        description: 'Application fee',
      },
    )
    expect(detail).toContain('fee paid')

    const applicant = await prisma.applicant.findUniqueOrThrow({ where: { id: lead.id } })
    expect(applicant.feePaidAt).not.toBeNull()
    expect(applicant.completedAt).not.toBeNull()

    const app = await prisma.application.findUniqueOrThrow({ where: { id: application.id } })
    expect(app.completedAt).not.toBeNull()

    const updatedProspect = await prisma.prospect.findUniqueOrThrow({
      where: { id: prospect.id },
    })
    expect(updatedProspect.status).toBe('APPLIED')

    const notification = await prisma.notification.findFirst({
      where: { recipientType: 'APPLICANT', recipientId: lead.id },
      orderBy: { createdAt: 'desc' },
    })
    expect(notification?.templateKey).toBe('application.fee_paid')
  })

  it('is idempotent - a duplicate delivery of the same event writes nothing twice', async () => {
    const { lead, application } = await seedApplication(5_000)
    await prisma.applicant.update({
      where: { id: lead.id },
      data: { stripeCustomerId: 'cus_test123', formSubmittedAt: new Date() },
    })

    const intent = {
      kind: 'payment_succeeded' as const,
      stripeObjectId: 'pi_dup',
      stripeCustomerId: 'cus_test123',
      stripeInvoiceId: null,
      stripePaymentIntentId: 'pi_dup',
      rail: 'CARD' as const,
      amountCents: 5_000,
      occurredAt: new Date(),
      description: 'Application fee',
    }
    const applicantRef = { id: lead.id, applicationId: application.id, firstName: lead.firstName }

    const first = await projectApplicationFeeEvent(applicantRef, intent)
    expect(first).toContain('fee paid')
    const second = await projectApplicationFeeEvent(applicantRef, intent)
    expect(second).toContain('already recorded')

    // notify() writes one row per channel the template declares - even a
    // non-addressable one, SUPPRESSED rather than skipped (that file's own
    // comment: "a channel with no address still gets a row saying so"). The
    // template here declares two (EMAIL, SMS), so ONE successful notify()
    // call always makes two rows; what idempotency means is that a SECOND
    // call adds none - checked on EMAIL alone, so the assertion is not
    // coupled to how many channels the template happens to declare.
    const emailNotifications = await prisma.notification.findMany({
      where: { recipientType: 'APPLICANT', recipientId: lead.id, channel: 'EMAIL' },
    })
    expect(emailNotifications).toHaveLength(1)
  })
})

describe('completeApplicantIfDone', () => {
  it('does nothing while the form is not yet submitted', async () => {
    const { lead, application } = await seedApplication(null)
    await completeApplicantIfDone(lead.id, application.id)
    const applicant = await prisma.applicant.findUniqueOrThrow({ where: { id: lead.id } })
    expect(applicant.completedAt).toBeNull()
  })
})

describe('applicationForProspect, householdFor, documentsForApplicant', () => {
  it('scopes the application to the property, and returns null outside scope', async () => {
    const { prospect, application } = await seedApplication(5_000)
    const found = await applicationForProspect(prospect.id, scopeOf([propertyId]))
    expect(found?.id).toBe(application.id)
    expect(found?.applicants).toHaveLength(1)

    const outOfScope = await applicationForProspect(prospect.id, scopeOf(['some-other-property']))
    expect(outOfScope).toBeNull()
  })

  it('lists household members without leaking contact info in the shape', async () => {
    const { application, lead } = await seedApplication(null)
    const members = await householdFor(application.id)
    expect(members).toHaveLength(1)
    expect(members[0]!.id).toBe(lead.id)
    expect(members[0]).not.toHaveProperty('email')
  })
})
