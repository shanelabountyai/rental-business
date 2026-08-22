'use server'

import {
  type HoaInfoInput,
  type InsurancePolicyInput,
  type MortgageInput,
  type WarrantyInput,
  validateCostBasis,
  validateHoaInfo,
  validateInsurancePolicy,
  validateMortgage,
  validateWarranty,
} from '@rental/core/filing-cabinet'
import {
  type CapitalImprovementInput,
  type MortgageAnnualStatementInput,
  validateCapitalImprovement,
  validateMortgageAnnualStatement,
} from '@rental/core/tax'
import { businessDateToUtc } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'

// Writes for the property filing cabinet (PROP-06, R-015). Same shape as
// lib/operational/actions.ts: a resource-carrying permission check first.
// No audit entries - none of these records are privileged or disputed the
// way an access-code reveal or a document delete is (same call R-014 made
// for appliance/utility CRUD).

export interface FormState {
  error?: string
  fieldErrors?: Record<string, string>
}

function violationsToState(
  violations: readonly { field: string; message: string }[],
): FormState {
  return {
    error: 'Fix the highlighted fields.',
    fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
  }
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/// Blank -> null, unparseable -> NaN (never silently 0) - see
/// packages/core/property/validate.ts's identical helper.
function optionalNumber(formData: FormData, name: string): number | null {
  const raw = str(formData, name)
  return raw ? Number(raw) : null
}

/// Forms collect whole dollars; the conversion to integer cents happens once,
/// here, at the write boundary (D-3) - same convention lib/units/actions.ts
/// uses for marketRentCents.
function optionalCents(formData: FormData, name: string): number | null {
  const dollars = optionalNumber(formData, name)
  return dollars != null ? Math.round(dollars * 100) : null
}

function propertyOrThrow(propertyId: string) {
  return prisma.property.findUniqueOrThrow({ where: { id: propertyId } })
}

export async function setCostBasis(
  propertyId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const property = await propertyOrThrow(propertyId)
  await requirePermission('property.write', propertyResource(property))

  const costBasisCents = optionalCents(formData, 'costBasisDollars')
  const violations = validateCostBasis(costBasisCents)
  if (violations.length > 0) return violationsToState(violations)

  await prisma.property.update({ where: { id: propertyId }, data: { costBasisCents } })
  revalidatePath(`/properties/${propertyId}`)
  redirect(`/properties/${propertyId}`)
}

export async function addMortgage(
  propertyId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const property = await propertyOrThrow(propertyId)
  await requirePermission('property.write', propertyResource(property))

  const rateType = str(formData, 'rateType')
  // The form collects a percent (e.g. 5.25); the write boundary converts to
  // basis points, same "friendlier unit in, smallest unit stored" pattern as
  // the dollars-to-cents conversion below.
  const interestRatePercent = optionalNumber(formData, 'interestRatePercent')
  const input: MortgageInput = {
    propertyId,
    lender: str(formData, 'lender'),
    originalAmountCents: optionalCents(formData, 'originalAmountDollars'),
    currentBalanceCents: optionalCents(formData, 'currentBalanceDollars'),
    rateType,
    interestRateBps: interestRatePercent != null ? Math.round(interestRatePercent * 100) : null,
    armAdjustmentDate: str(formData, 'armAdjustmentDate') || null,
    maturityDate: str(formData, 'maturityDate') || null,
    isBalloon: formData.get('isBalloon') === 'on',
    notes: str(formData, 'notes') || null,
  }
  const violations = validateMortgage(input)
  if (violations.length > 0) return violationsToState(violations)

  await prisma.mortgage.create({
    data: {
      propertyId,
      lender: input.lender,
      originalAmountCents: input.originalAmountCents,
      currentBalanceCents: input.currentBalanceCents,
      rateType: input.rateType,
      interestRateBps: input.interestRateBps,
      armAdjustmentDate: input.armAdjustmentDate ? new Date(input.armAdjustmentDate) : null,
      maturityDate: input.maturityDate ? new Date(input.maturityDate) : null,
      isBalloon: input.isBalloon,
      notes: input.notes,
    },
  })

  revalidatePath(`/properties/${propertyId}`)
  redirect(`/properties/${propertyId}`)
}

export async function deleteMortgage(propertyId: string, mortgageId: string): Promise<FormState> {
  const property = await propertyOrThrow(propertyId)
  await requirePermission('property.write', propertyResource(property))

  await prisma.mortgage.deleteMany({ where: { id: mortgageId, propertyId } })
  revalidatePath(`/properties/${propertyId}`)
  return {}
}

export async function addInsurancePolicy(
  propertyId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const property = await propertyOrThrow(propertyId)
  await requirePermission('property.write', propertyResource(property))

  const input: InsurancePolicyInput = {
    propertyId,
    carrier: str(formData, 'carrier'),
    policyNumber: str(formData, 'policyNumber') || null,
    limitsCents: optionalCents(formData, 'limitsDollars'),
    deductibleCents: optionalCents(formData, 'deductibleDollars'),
    lossOfRents: formData.get('lossOfRents') === 'on',
    renewsOn: str(formData, 'renewsOn'),
    notes: str(formData, 'notes') || null,
  }
  const violations = validateInsurancePolicy(input)
  if (violations.length > 0) return violationsToState(violations)

  await prisma.insurancePolicy.create({
    data: {
      propertyId,
      carrier: input.carrier,
      policyNumber: input.policyNumber,
      limitsCents: input.limitsCents,
      deductibleCents: input.deductibleCents,
      lossOfRents: input.lossOfRents,
      renewsOn: new Date(input.renewsOn),
      notes: input.notes,
    },
  })

  revalidatePath(`/properties/${propertyId}`)
  redirect(`/properties/${propertyId}`)
}

export async function deleteInsurancePolicy(
  propertyId: string,
  insurancePolicyId: string,
): Promise<FormState> {
  const property = await propertyOrThrow(propertyId)
  await requirePermission('property.write', propertyResource(property))

  await prisma.insurancePolicy.deleteMany({ where: { id: insurancePolicyId, propertyId } })
  revalidatePath(`/properties/${propertyId}`)
  return {}
}

/// Upsert, not create: HoaInfo is unique on propertyId - a property has at
/// most one HOA, so setting it again replaces the record rather than
/// producing a second row that would violate the constraint (same reasoning
/// as lib/operational/actions.ts's setShutoffLocation).
export async function setHoaInfo(
  propertyId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const property = await propertyOrThrow(propertyId)
  await requirePermission('property.write', propertyResource(property))

  const input: HoaInfoInput = {
    propertyId,
    name: str(formData, 'name') || null,
    contactInfo: str(formData, 'contactInfo') || null,
    hasRentalCap: formData.get('hasRentalCap') === 'on',
    rentalCapPolicy: str(formData, 'rentalCapPolicy') || null,
    notes: str(formData, 'notes') || null,
  }
  const violations = validateHoaInfo(input)
  if (violations.length > 0) return violationsToState(violations)

  await prisma.hoaInfo.upsert({
    where: { propertyId },
    create: {
      propertyId,
      name: input.name,
      contactInfo: input.contactInfo,
      hasRentalCap: input.hasRentalCap,
      rentalCapPolicy: input.rentalCapPolicy,
      notes: input.notes,
    },
    update: {
      name: input.name,
      contactInfo: input.contactInfo,
      hasRentalCap: input.hasRentalCap,
      rentalCapPolicy: input.rentalCapPolicy,
      notes: input.notes,
    },
  })

  revalidatePath(`/properties/${propertyId}`)
  redirect(`/properties/${propertyId}`)
}

export async function addWarranty(
  propertyId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const property = await propertyOrThrow(propertyId)
  await requirePermission('property.write', propertyResource(property))

  const input: WarrantyInput = {
    propertyId,
    category: str(formData, 'category'),
    provider: str(formData, 'provider'),
    coverageSummary: str(formData, 'coverageSummary') || null,
    expiresOn: str(formData, 'expiresOn') || null,
    notes: str(formData, 'notes') || null,
  }
  const violations = validateWarranty(input)
  if (violations.length > 0) return violationsToState(violations)

  await prisma.warranty.create({
    data: {
      propertyId,
      category: input.category,
      provider: input.provider,
      coverageSummary: input.coverageSummary,
      expiresOn: input.expiresOn ? new Date(input.expiresOn) : null,
      notes: input.notes,
    },
  })

  revalidatePath(`/properties/${propertyId}`)
  redirect(`/properties/${propertyId}`)
}

export async function deleteWarranty(propertyId: string, warrantyId: string): Promise<FormState> {
  const property = await propertyOrThrow(propertyId)
  await requirePermission('property.write', propertyResource(property))

  await prisma.warranty.deleteMany({ where: { id: warrantyId, propertyId } })
  revalidatePath(`/properties/${propertyId}`)
  return {}
}

/// PROP-07 (R-078): a capital project - roof, HVAC, repipe. Recorded here
/// rather than as a flag on a work order because the improvements that
/// matter most to a return are the ones that predate the platform ("roof
/// 2024") and the ones bought straight from a contractor, neither of which
/// has a work order to carry a flag.
export async function addCapitalImprovement(
  propertyId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const property = await propertyOrThrow(propertyId)
  const actor = await requirePermission('property.write', propertyResource(property))

  const input: CapitalImprovementInput = {
    propertyId,
    category: str(formData, 'category'),
    description: str(formData, 'description'),
    costCents: optionalCents(formData, 'costDollars'),
    inServiceOn: str(formData, 'inServiceOn') || null,
    workOrderId: str(formData, 'workOrderId') || null,
    notes: str(formData, 'notes') || null,
  }
  const violations = validateCapitalImprovement(input)
  if (violations.length > 0) return violationsToState(violations)

  // The work order must belong to THIS property. Without the check a
  // mistyped id would capitalise a job on somebody else's house and quietly
  // remove its cost from that property's deductible repairs.
  if (input.workOrderId) {
    const job = await prisma.workOrder.findFirst({
      where: { id: input.workOrderId, propertyId },
      select: { id: true },
    })
    if (!job) {
      return violationsToState([
        { field: 'workOrderId', message: 'No work order on this property has that ID.' },
      ])
    }
  }

  await prisma.capitalImprovement.create({
    data: {
      propertyId,
      category: input.category,
      description: input.description,
      // Validated above as a positive integer, so the assertion is safe.
      costCents: input.costCents as number,
      // `@db.Date`: the calendar day it was placed in service, converted the
      // one way a date-only value may be (D-3).
      inServiceOn: input.inServiceOn ? businessDateToUtc(input.inServiceOn) : null,
      workOrderId: input.workOrderId || null,
      notes: input.notes,
      recordedByStaffId: actor.id,
    },
  })

  revalidatePath(`/properties/${propertyId}`)
  redirect(`/properties/${propertyId}`)
}

export async function deleteCapitalImprovement(
  propertyId: string,
  capitalImprovementId: string,
): Promise<FormState> {
  const property = await propertyOrThrow(propertyId)
  await requirePermission('property.write', propertyResource(property))

  await prisma.capitalImprovement.deleteMany({ where: { id: capitalImprovementId, propertyId } })
  revalidatePath(`/properties/${propertyId}`)
  return {}
}

/// RPT-07 (R-081b): the lender's Form 1098 for one year. Upsert on
/// (mortgageId, taxYear), which is a unique index - re-entering a corrected
/// 1098 replaces the figure rather than doubling Schedule E line 12.
export async function recordMortgageStatement(
  propertyId: string,
  mortgageId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const property = await propertyOrThrow(propertyId)
  const actor = await requirePermission('property.write', propertyResource(property))

  // The mortgage must belong to THIS property, or a mistyped id would put
  // another house's interest on this one's Schedule E.
  const mortgage = await prisma.mortgage.findFirst({
    where: { id: mortgageId, propertyId },
    select: { id: true },
  })
  if (!mortgage) {
    return violationsToState([
      { field: 'mortgageId', message: 'No mortgage on this property has that ID.' },
    ])
  }

  const input: MortgageAnnualStatementInput = {
    mortgageId,
    taxYear: optionalNumber(formData, 'taxYear'),
    interestCents: optionalCents(formData, 'interestDollars'),
    principalCents: optionalCents(formData, 'principalDollars'),
    escrowCents: optionalCents(formData, 'escrowDollars'),
    notes: str(formData, 'notes') || null,
  }
  const violations = validateMortgageAnnualStatement(input)
  if (violations.length > 0) return violationsToState(violations)

  const taxYear = input.taxYear as number
  const interestCents = input.interestCents as number
  await prisma.mortgageAnnualStatement.upsert({
    where: { mortgageId_taxYear: { mortgageId, taxYear } },
    create: {
      mortgageId,
      taxYear,
      interestCents,
      principalCents: input.principalCents,
      escrowCents: input.escrowCents,
      notes: input.notes,
      recordedByStaffId: actor.id,
    },
    update: {
      interestCents,
      principalCents: input.principalCents,
      escrowCents: input.escrowCents,
      notes: input.notes,
      recordedByStaffId: actor.id,
    },
  })

  revalidatePath(`/properties/${propertyId}`)
  redirect(`/properties/${propertyId}`)
}

export async function deleteMortgageStatement(
  propertyId: string,
  statementId: string,
): Promise<FormState> {
  const property = await propertyOrThrow(propertyId)
  await requirePermission('property.write', propertyResource(property))

  await prisma.mortgageAnnualStatement.deleteMany({
    where: { id: statementId, mortgage: { propertyId } },
  })
  revalidatePath(`/properties/${propertyId}`)
  return {}
}
