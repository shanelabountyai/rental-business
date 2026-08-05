'use server'

import { openSecret, sealSecret } from '@rental/core/auth'
import {
  type AccessCodeInput,
  type ApplianceInput,
  type ShutoffLocationInput,
  type UtilityAccountInput,
  validateAccessCode,
  validateAppliance,
  validateShutoffLocation,
  validateUtilityAccount,
} from '@rental/core/operational'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'

// Writes for unit operational data (PROP-03, R-014). Same shape as every
// other lib/*/actions.ts: a resource-carrying permission check first, then a
// transaction pairing the write with its audit entry where one is
// warranted - which for this item is only the access-code write and reveal,
// not the appliance/utility/shutoff CRUD (the same "not everything needs an
// audit entry, only what a later dispute would ask about" call R-011 made
// for Task creation).

const ACCESS_CODE_PURPOSE = 'access-code'

export interface FormState {
  error?: string
  fieldErrors?: Record<string, string>
}

export interface RevealState extends FormState {
  code?: string
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

async function unitWithPropertyOrThrow(unitId: string) {
  return prisma.unit.findUniqueOrThrow({ where: { id: unitId }, include: { property: true } })
}

/**
 * Adds a new access-code version, closing out whichever version was
 * open-ended before it - the exact pattern R-010's `createRuleVersion` uses
 * for JurisdictionRule, reused because the shape is identical: never edit a
 * version in place, add the next one, keep every prior version on record.
 */
export async function addAccessCode(
  unitId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const unit = await unitWithPropertyOrThrow(unitId)
  const actor = await requirePermission('unit.write', propertyResource(unit.property))

  const input: AccessCodeInput = {
    unitId,
    type: str(formData, 'type'),
    label: str(formData, 'label') || null,
    code: str(formData, 'code'),
  }
  const violations = validateAccessCode(input)
  if (violations.length > 0) return violationsToState(violations)

  const previous = await prisma.accessCode.findFirst({
    where: { unitId, type: input.type, effectiveTo: null },
    orderBy: { version: 'desc' },
  })
  const version = (previous?.version ?? 0) + 1

  await prisma.$transaction(async (tx) => {
    if (previous) {
      await tx.accessCode.update({ where: { id: previous.id }, data: { effectiveTo: new Date() } })
    }
    const created = await tx.accessCode.create({
      data: {
        unitId,
        type: input.type,
        label: input.label,
        sealedCode: sealSecret(input.code, ACCESS_CODE_PURPOSE),
        version,
        createdByStaffId: actor.id,
      },
    })
    await audit(
      {
        action: 'accesscode.set',
        entityType: 'AccessCode',
        entityId: created.id,
        propertyId: unit.propertyId,
        after: { type: created.type, label: created.label, version: created.version },
      },
      tx,
    )
  })

  revalidatePath(`/properties/${unit.propertyId}/units/${unitId}`)
  redirect(`/properties/${unit.propertyId}/units/${unitId}`)
}

/**
 * Decrypts and returns one access-code version. Privileged
 * (PRIVILEGED_PERMISSIONS includes 'accesscode.reveal') and therefore
 * MFA-gated by requirePermission already - no extra check needed here.
 * `workOrderId` is optional: most reveals today happen with no work order to
 * attach (no vendor portal exists yet to drive the "per-work-order" half of
 * PROP-03 for real - see this item's PROGRESS entry), but it is recorded on
 * the audit entry whenever a caller does have one.
 */
export async function revealAccessCode(
  unitId: string,
  accessCodeId: string,
  workOrderId: string | null,
): Promise<RevealState> {
  const unit = await unitWithPropertyOrThrow(unitId)
  await requirePermission('accesscode.reveal', propertyResource(unit.property))

  const accessCode = await prisma.accessCode.findUniqueOrThrow({ where: { id: accessCodeId } })
  if (accessCode.unitId !== unitId) {
    return { error: 'This code does not belong to this unit.' }
  }

  const code = openSecret(accessCode.sealedCode, ACCESS_CODE_PURPOSE)
  if (code == null) {
    return { error: 'This code could not be decrypted. It may predate a secret rotation.' }
  }

  await audit({
    action: 'accesscode.revealed',
    entityType: 'AccessCode',
    entityId: accessCode.id,
    propertyId: unit.propertyId,
    after: { type: accessCode.type, version: accessCode.version, workOrderId: workOrderId ?? null },
  })

  return { code }
}

export async function addAppliance(
  unitId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const unit = await unitWithPropertyOrThrow(unitId)
  await requirePermission('unit.write', propertyResource(unit.property))

  const input: ApplianceInput = {
    unitId,
    category: str(formData, 'category'),
    make: str(formData, 'make') || null,
    model: str(formData, 'model') || null,
    serialNumber: str(formData, 'serialNumber') || null,
    installedOn: str(formData, 'installedOn') || null,
    filterSize: str(formData, 'filterSize') || null,
    notes: str(formData, 'notes') || null,
  }
  const violations = validateAppliance(input)
  if (violations.length > 0) return violationsToState(violations)

  await prisma.appliance.create({
    data: {
      unitId,
      category: input.category,
      make: input.make,
      model: input.model,
      serialNumber: input.serialNumber,
      installedOn: input.installedOn ? new Date(input.installedOn) : null,
      filterSize: input.filterSize,
      notes: input.notes,
    },
  })

  revalidatePath(`/properties/${unit.propertyId}/units/${unitId}`)
  redirect(`/properties/${unit.propertyId}/units/${unitId}`)
}

export async function deleteAppliance(unitId: string, applianceId: string): Promise<FormState> {
  const unit = await unitWithPropertyOrThrow(unitId)
  await requirePermission('unit.write', propertyResource(unit.property))

  await prisma.appliance.deleteMany({ where: { id: applianceId, unitId } })
  revalidatePath(`/properties/${unit.propertyId}/units/${unitId}`)
  return {}
}

export async function addUtilityAccount(
  unitId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const unit = await unitWithPropertyOrThrow(unitId)
  await requirePermission('unit.write', propertyResource(unit.property))

  const input: UtilityAccountInput = {
    unitId,
    type: str(formData, 'type'),
    provider: str(formData, 'provider'),
    accountNumber: str(formData, 'accountNumber') || null,
    nameOnAccountDuringTenancy: str(formData, 'nameOnAccountDuringTenancy') || null,
    nameOnAccountVacancy: str(formData, 'nameOnAccountVacancy') || null,
    landlordRevertAgreement: formData.get('landlordRevertAgreement') === 'on',
    notes: str(formData, 'notes') || null,
  }
  const violations = validateUtilityAccount(input)
  if (violations.length > 0) return violationsToState(violations)

  await prisma.utilityAccount.create({
    data: {
      unitId,
      type: input.type,
      provider: input.provider,
      accountNumber: input.accountNumber,
      nameOnAccountDuringTenancy: input.nameOnAccountDuringTenancy,
      nameOnAccountVacancy: input.nameOnAccountVacancy,
      landlordRevertAgreement: input.landlordRevertAgreement,
      notes: input.notes,
    },
  })

  revalidatePath(`/properties/${unit.propertyId}/units/${unitId}`)
  redirect(`/properties/${unit.propertyId}/units/${unitId}`)
}

export async function deleteUtilityAccount(
  unitId: string,
  utilityAccountId: string,
): Promise<FormState> {
  const unit = await unitWithPropertyOrThrow(unitId)
  await requirePermission('unit.write', propertyResource(unit.property))

  await prisma.utilityAccount.deleteMany({ where: { id: utilityAccountId, unitId } })
  revalidatePath(`/properties/${unit.propertyId}/units/${unitId}`)
  return {}
}

/// Upsert, not create: ShutoffLocation is unique on (unitId, type) - a unit
/// has exactly one water main, so setting it again replaces the description
/// rather than producing a second row that would violate the constraint.
export async function setShutoffLocation(
  unitId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const unit = await unitWithPropertyOrThrow(unitId)
  await requirePermission('unit.write', propertyResource(unit.property))

  const input: ShutoffLocationInput = {
    unitId,
    type: str(formData, 'type'),
    description: str(formData, 'description'),
  }
  const violations = validateShutoffLocation(input)
  if (violations.length > 0) return violationsToState(violations)

  await prisma.shutoffLocation.upsert({
    where: { unitId_type: { unitId, type: input.type } },
    create: { unitId, type: input.type, description: input.description },
    update: { description: input.description },
  })

  revalidatePath(`/properties/${unit.propertyId}/units/${unitId}`)
  redirect(`/properties/${unit.propertyId}/units/${unitId}`)
}
