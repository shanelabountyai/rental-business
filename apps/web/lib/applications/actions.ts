'use server'

import { createHash } from 'node:crypto'
import {
  type ApplicantFormInput,
  type CoApplicantInviteInput,
  validateApplicantForm,
  validateCoApplicantInvite,
} from '@rental/core/applications'
import { RATE_LIMITS } from '@rental/core/auth'
import { validateDocument } from '@rental/core/documents'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { authUrl } from '@/lib/auth/delivery.ts'
import { consumeRateLimit, issueToken } from '@/lib/auth/store.ts'
import { getBillingProvider } from '@/lib/billing/provider.ts'
import { notify } from '@/lib/notifications/send.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'
import { completeApplicantIfDone } from './fee-webhook.ts'
import { applicationLinkStatus } from './link.ts'

// PUBLIC writes for Application/Applicant (LEASE-03, R-059) - no session,
// same posture as prospects/actions.ts: every write here is authorized by
// possessing a valid APPLICATION_LINK, not by a permission check, because
// the caller has no account by definition. DELIBERATELY SEPARATE from
// staff-actions.ts for the identical Auth.js/Vitest reason that file's own
// header states (and prospects/actions.ts's, before it).

const LINK_ERROR_MESSAGES: Record<string, string> = {
  not_found: 'This link is not valid.',
  wrong_purpose: 'This link is not valid.',
  wrong_subject: 'This link is not valid.',
  expired: 'This link has expired. Contact the office for a new one.',
  already_used: 'This link is not valid.',
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

function optionalCents(formData: FormData, name: string): number | null {
  const raw = str(formData, name)
  if (!raw) return null
  return Math.round(Number(raw) * 100)
}

function parseDateOnly(raw: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim())
  if (!match) return null
  const [, y, m, d] = match
  const date = new Date(Date.UTC(+y!, +m! - 1, +d!))
  return Number.isNaN(date.getTime()) ? null : date
}

function violationsToState(
  violations: readonly { field: string; message: string }[],
): ApplicantFormState {
  return {
    error: 'Fix the highlighted fields.',
    fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
  }
}

export interface ApplicantFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

/**
 * One applicant's own section. `intent` decides what "submit" means:
 * `save` writes whatever was filled with no validation - the PRD's
 * save-and-resume, unblocked by an incomplete field - and `submit`
 * validates everything and, once clean, marks the form done. A fee still
 * due is NOT blocked here; `completeApplicantIfDone` (this applicant's
 * `completedAt`) only fires once the fee also clears, which the page reads
 * to decide whether to show the payment step next.
 */
export async function submitApplicantForm(
  rawToken: string,
  _previous: ApplicantFormState,
  formData: FormData,
): Promise<ApplicantFormState> {
  const status = await applicationLinkStatus(rawToken)
  if (!status.ok) {
    return { error: LINK_ERROR_MESSAGES[status.reason] ?? 'This link is not valid.' }
  }
  if (status.applicant.completedAt) {
    return { error: 'This application is already complete.' }
  }

  const input: ApplicantFormInput = {
    firstName: str(formData, 'firstName'),
    lastName: str(formData, 'lastName'),
    email: str(formData, 'email') || null,
    phone: str(formData, 'phone') || null,
    dateOfBirth: parseDateOnly(str(formData, 'dateOfBirth')),
    currentAddressLine1: str(formData, 'currentAddressLine1'),
    currentCity: str(formData, 'currentCity'),
    currentState: str(formData, 'currentState'),
    currentPostalCode: str(formData, 'currentPostalCode'),
    monthsAtCurrentAddress: str(formData, 'monthsAtCurrentAddress')
      ? Number(str(formData, 'monthsAtCurrentAddress'))
      : null,
    employerName: str(formData, 'employerName') || null,
    monthlyIncomeCents: optionalCents(formData, 'monthlyIncome'),
  }

  const intent = str(formData, 'intent')
  const fieldData = {
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    phone: input.phone,
    dateOfBirth: input.dateOfBirth,
    currentAddressLine1: input.currentAddressLine1,
    currentCity: input.currentCity,
    currentState: input.currentState,
    currentPostalCode: input.currentPostalCode,
    monthsAtCurrentAddress: input.monthsAtCurrentAddress,
    employerName: input.employerName,
    monthlyIncomeCents: input.monthlyIncomeCents,
  }

  if (intent !== 'submit') {
    // SAVE: every field is written as given, blank or not - "progress is
    // saved" means exactly that, not "progress that happens to validate".
    await prisma.applicant.update({ where: { id: status.applicant.id }, data: fieldData })
    await auditAsSystem(`applicant:${status.applicant.id}`, {
      action: 'application.applicant_saved',
      entityType: 'Applicant',
      entityId: status.applicant.id,
      propertyId: status.application.propertyId,
    })
    revalidatePath(`/apply/${rawToken}`)
    return { notice: 'Saved. Come back anytime to finish.' }
  }

  const violations = validateApplicantForm(input, new Date())
  if (violations.length > 0) {
    // Still saved, even though it did not validate - a rejected submit must
    // not throw away what was typed.
    await prisma.applicant.update({ where: { id: status.applicant.id }, data: fieldData })
    return violationsToState(violations)
  }

  await prisma.applicant.update({
    where: { id: status.applicant.id },
    data: { ...fieldData, formSubmittedAt: new Date() },
  })
  await auditAsSystem(`applicant:${status.applicant.id}`, {
    action: 'application.applicant_saved',
    entityType: 'Applicant',
    entityId: status.applicant.id,
    propertyId: status.application.propertyId,
  })
  // No fee due completes the applicant right here; a fee due waits for the
  // webhook (see that function's own header).
  await completeApplicantIfDone(status.applicant.id, status.applicant.applicationId)

  revalidatePath(`/apply/${rawToken}`)
  return { notice: 'Submitted.' }
}

/**
 * The lead adds a co-applicant (LEASE-03: "co-applicants get their own
 * links"). LEAD-ONLY - a co-applicant adding a further co-applicant would
 * make "who is actually applying" a question with no single answer.
 */
export async function inviteCoApplicant(
  rawToken: string,
  _previous: ApplicantFormState,
  formData: FormData,
): Promise<ApplicantFormState> {
  const status = await applicationLinkStatus(rawToken)
  if (!status.ok) {
    return { error: LINK_ERROR_MESSAGES[status.reason] ?? 'This link is not valid.' }
  }
  if (!status.applicant.isLead) {
    return { error: 'Only the person who started this application can add co-applicants.' }
  }

  const input: CoApplicantInviteInput = {
    firstName: str(formData, 'firstName'),
    lastName: str(formData, 'lastName'),
    email: str(formData, 'email') || null,
    phone: str(formData, 'phone') || null,
  }
  const violations = validateCoApplicantInvite(input)
  if (violations.length > 0) return violationsToState(violations)

  const created = await prisma.$transaction(async (tx) => {
    const applicant = await tx.applicant.create({
      data: {
        applicationId: status.applicant.applicationId,
        isLead: false,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
        feeCents: status.applicant.feeCents,
      },
    })
    await auditAsSystem(
      `applicant:${applicant.id}`,
      {
        action: 'application.coapplicant_added',
        entityType: 'Applicant',
        entityId: applicant.id,
        propertyId: status.application.propertyId,
        after: { addedByApplicantId: status.applicant.id },
      },
      tx,
    )
    return applicant
  })

  const issued = await issueToken('APPLICATION_LINK', { type: 'Applicant', id: created.id })
  const property = await prisma.property.findUniqueOrThrow({
    where: { id: status.application.propertyId },
  })
  await notify({
    category: 'prospect_application',
    templateKey: 'application.coapplicant_invite',
    recipient: { type: 'APPLICANT', id: created.id, email: created.email, phone: created.phone },
    context: {
      firstName: created.firstName,
      leadName: `${status.applicant.firstName} ${status.applicant.lastName}`,
      addressLine1: property.addressLine1,
      url: authUrl(`/apply/${issued.token}`),
    },
    propertyId: status.application.propertyId,
    idempotencyKey: `applicant-invite:${created.id}`,
  })

  revalidatePath(`/apply/${rawToken}`)
  return { notice: `${input.firstName} has been sent their own link.` }
}

/**
 * ID or income document, attached to the uploading applicant only (never
 * the household) - screening (R-060) reads one person's documents at a
 * time.
 */
export async function uploadApplicationDocument(
  rawToken: string,
  _previous: ApplicantFormState,
  formData: FormData,
): Promise<ApplicantFormState> {
  const status = await applicationLinkStatus(rawToken)
  if (!status.ok) {
    return { error: LINK_ERROR_MESSAGES[status.reason] ?? 'This link is not valid.' }
  }

  const limit = await consumeRateLimit(
    `application-upload:${status.applicant.id}`,
    RATE_LIMITS.applicationDocumentUpload,
  )
  if (!limit.allowed) {
    return { error: 'Too many uploads. Wait a few minutes and try again.' }
  }

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return violationsToState([{ field: 'file', message: 'Choose a file.' }])
  }

  const violations = validateDocument({
    propertyId: status.application.propertyId,
    unitId: null,
    type: 'APPLICATION',
    fileName: file.name,
    contentType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
  })
  if (violations.length > 0) return violationsToState(violations)

  const buffer = Buffer.from(await file.arrayBuffer())
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const storageKey = generateStorageKey(status.application.propertyId, file.name)
  await storage.put(storageKey, buffer, file.type || 'application/octet-stream')

  await prisma.$transaction(async (tx) => {
    const created = await tx.document.create({
      data: {
        propertyId: status.application.propertyId,
        applicantId: status.applicant.id,
        type: 'APPLICATION',
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        storageKey,
        sha256,
      },
    })
    await auditAsSystem(
      `applicant:${status.applicant.id}`,
      {
        action: 'document.uploaded',
        entityType: 'Document',
        entityId: created.id,
        propertyId: status.application.propertyId,
        after: { type: created.type, fileName: created.fileName },
      },
      tx,
    )
  })

  revalidatePath(`/apply/${rawToken}`)
  return { notice: `${file.name} uploaded.` }
}

export interface FeePaymentState {
  error?: string
  clientSecret?: string
}

/**
 * Starts (or resumes) this applicant's own fee payment. Stripe-hosted
 * fields only (master PRD §6.6) - this returns a client secret and never
 * sees a card or bank number.
 */
export async function startApplicationFeePayment(rawToken: string): Promise<FeePaymentState> {
  const status = await applicationLinkStatus(rawToken)
  if (!status.ok) {
    return { error: LINK_ERROR_MESSAGES[status.reason] ?? 'This link is not valid.' }
  }
  const { applicant } = status
  if (!applicant.feeCents || applicant.feeCents <= 0) {
    return { error: 'No fee is due.' }
  }
  if (applicant.feePaidAt) {
    return { error: 'This fee is already paid.' }
  }

  const provider = getBillingProvider()
  let stripeCustomerId = applicant.stripeCustomerId
  if (!stripeCustomerId) {
    const customer = await provider.createApplicationFeeCustomer({
      applicantId: applicant.id,
      applicationId: applicant.applicationId,
      propertyId: status.application.propertyId,
      name: `${applicant.firstName} ${applicant.lastName}`,
      email: applicant.email,
      phone: applicant.phone,
    })
    stripeCustomerId = customer.stripeCustomerId
    await prisma.applicant.update({
      where: { id: applicant.id },
      data: { stripeCustomerId },
    })
  }

  const intent = await provider.createApplicationFeePaymentIntent({
    stripeCustomerId,
    amountCents: applicant.feeCents,
    currency: 'usd',
    applicantId: applicant.id,
    // Stable per applicant - a retried request must not become a second
    // PaymentIntent for the same fee.
    idempotencyKey: `application-fee-intent:${applicant.id}`,
  })

  return { clientSecret: intent.clientSecret }
}
