'use server'

import {
  type LeaseStatusValue,
  type NoticePartyValue,
  canGiveNotice,
  leaseCents,
  leaseIsInForce,
  leaseTransition,
  parseLeaseDate,
  validateGuarantor,
  validateLease,
} from '@rental/core/leases'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { provisionLeaseBilling } from '@/lib/billing/provision.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { raiseIntakeTasks } from './intake.ts'

// Writes for lease records (LEASE-06, RISK-08, R-033). Same shape as every
// other lib/*/actions.ts in this repo: a resource-carrying permission check
// first, then a transaction pairing the write with its audit entry.
//
// EVERY status change goes through `leaseTransition()` in packages/core.
// Nothing here sets `status` directly - see that module's header for why a
// guarded machine, rather than a column anybody can assign, is what keeps
// R-034's billing and R-071's deposit clock from each having to defend
// themselves against states that should have been impossible.

export interface LeaseFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

function violationsToState(
  violations: readonly { field: string; message: string }[],
): LeaseFormState {
  return {
    error: 'Fix the highlighted fields.',
    fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
  }
}

/// The lease plus the permission check for writing to it, against ITS OWN
/// property. A lease id copied from somewhere it should not have been is
/// refused by `requirePermission`, because a property-scoped manager's grant
/// only matches when the resource names a property they actually hold - the
/// id itself is never the authorization.
async function leaseForWrite(leaseId: string) {
  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: leaseId },
    include: {
      property: { select: { id: true, legalEntityId: true, timezone: true } },
      leaseTenants: { select: { id: true } },
    },
  })
  const actor = await requirePermission('lease.write', propertyResource(lease.property))
  return { lease, actor }
}

/**
 * Creates a tenancy record.
 *
 * Always DRAFT. There is no "create it already active" shortcut, including
 * for the inherited path: activation has preconditions (`activationGaps`)
 * that a create form cannot satisfy on its own, because the parties are
 * added afterwards. A lease that came into being already live would be a
 * lease nobody checked.
 */
export async function createLease(
  _previous: LeaseFormState,
  formData: FormData,
): Promise<LeaseFormState> {
  const unitId = str(formData, 'unitId')
  const unit = unitId
    ? await prisma.unit.findUnique({
        where: { id: unitId },
        include: { property: { select: { id: true, legalEntityId: true } } },
      })
    : null
  if (!unit) {
    return { error: 'Choose the unit.', fieldErrors: { unitId: 'Choose the unit.' } }
  }
  await requirePermission('lease.write', propertyResource(unit.property))

  const isMonthToMonth = formData.get('isMonthToMonth') === 'yes'
  const origin = str(formData, 'origin') === 'INHERITED' ? 'INHERITED' : 'APPLICATION'

  const input = {
    unitId,
    startsOn: str(formData, 'startsOn'),
    endsOn: str(formData, 'endsOn') || null,
    rentDollars: str(formData, 'rentDollars'),
    depositDollars: str(formData, 'depositDollars') || null,
    rentDueDay: str(formData, 'rentDueDay') || '1',
    isMonthToMonth,
    mtmRentDollars: str(formData, 'mtmRentDollars') || null,
  }
  const violations = validateLease(input)
  if (violations.length > 0) return violationsToState(violations)

  // An inherited tenancy's deposit position starts as UNKNOWN, never as the
  // NOT_APPLICABLE default - see LeaseOrigin's own schema comment. That
  // single assignment is what puts it on the outstanding-items list instead
  // of letting it sit looking settled.
  const depositTransferStatus = origin === 'INHERITED' ? 'UNKNOWN' : 'NOT_APPLICABLE'

  const lease = await prisma.$transaction(async (tx) => {
    const created = await tx.lease.create({
      data: {
        propertyId: unit.propertyId,
        unitId,
        status: 'DRAFT',
        origin,
        depositTransferStatus,
        startsOn: parseLeaseDate(input.startsOn)!,
        endsOn: input.endsOn ? parseLeaseDate(input.endsOn) : null,
        rentCents: leaseCents(input.rentDollars)!,
        depositCents: leaseCents(input.depositDollars) ?? 0,
        rentDueDay: Number(input.rentDueDay),
        isMonthToMonth,
        mtmRentCents: leaseCents(input.mtmRentDollars),
        utilityResponsibility: readUtilities(formData),
      },
    })
    await audit(
      {
        action: 'lease.created',
        entityType: 'Lease',
        entityId: created.id,
        propertyId: unit.propertyId,
        after: {
          origin,
          unitId,
          startsOn: created.startsOn.toISOString(),
          endsOn: created.endsOn?.toISOString() ?? null,
          rentCents: created.rentCents,
          depositCents: created.depositCents,
          depositTransferStatus,
        },
      },
      tx,
    )
    return created
  })

  // Outside the transaction: the lease exists whether or not the prompts
  // land, and a failed Task write must not roll back the record itself.
  if (origin === 'INHERITED') {
    await raiseIntakeTasks(lease.id).catch((error) => {
      console.error(`[lease] intake tasks failed for ${lease.id}`, error)
    })
  }

  revalidatePath('/leases')
  redirect(`/leases/${lease.id}`)
}

/// LEASE-06's utility responsibility matrix, read off the form. Stored as
/// JSON because the shape is a lease-template concern (R-063) and
/// normalizing it before there is a template to normalize against would be
/// guessing at the schema.
function readUtilities(formData: FormData): Record<string, string> {
  const matrix: Record<string, string> = {}
  for (const [key, value] of formData.entries()) {
    if (key.startsWith('utility.') && typeof value === 'string' && value) {
      matrix[key.slice('utility.'.length)] = value
    }
  }
  return matrix
}

export async function updateLeaseTerms(
  leaseId: string,
  _previous: LeaseFormState,
  formData: FormData,
): Promise<LeaseFormState> {
  const { lease } = await leaseForWrite(leaseId)

  const isMonthToMonth = formData.get('isMonthToMonth') === 'yes'
  const input = {
    unitId: lease.unitId,
    startsOn: str(formData, 'startsOn'),
    endsOn: str(formData, 'endsOn') || null,
    rentDollars: str(formData, 'rentDollars'),
    depositDollars: str(formData, 'depositDollars') || null,
    rentDueDay: str(formData, 'rentDueDay') || '1',
    isMonthToMonth,
    mtmRentDollars: str(formData, 'mtmRentDollars') || null,
  }
  const violations = validateLease(input)
  if (violations.length > 0) return violationsToState(violations)

  const before = {
    startsOn: lease.startsOn.toISOString(),
    endsOn: lease.endsOn?.toISOString() ?? null,
    rentCents: lease.rentCents,
    depositCents: lease.depositCents,
    rentDueDay: lease.rentDueDay,
    isMonthToMonth: lease.isMonthToMonth,
    mtmRentCents: lease.mtmRentCents,
  }
  const after = {
    startsOn: parseLeaseDate(input.startsOn)!,
    endsOn: input.endsOn ? parseLeaseDate(input.endsOn) : null,
    rentCents: leaseCents(input.rentDollars)!,
    depositCents: leaseCents(input.depositDollars) ?? 0,
    rentDueDay: Number(input.rentDueDay),
    isMonthToMonth,
    mtmRentCents: leaseCents(input.mtmRentDollars),
  }

  await prisma.$transaction(async (tx) => {
    await tx.lease.update({
      where: { id: leaseId },
      data: { ...after, utilityResponsibility: readUtilities(formData) },
    })
    await audit(
      {
        action: 'lease.updated',
        entityType: 'Lease',
        entityId: leaseId,
        propertyId: lease.propertyId,
        before,
        after: {
          ...after,
          startsOn: after.startsOn.toISOString(),
          endsOn: after.endsOn?.toISOString() ?? null,
        },
      },
      tx,
    )
  })

  revalidatePath(`/leases/${leaseId}`)
  return { notice: 'Saved.' }
}

/**
 * Moves the lease through its lifecycle.
 *
 * The unit's own status is coupled here rather than left to a nightly job:
 * activating a lease occupies the unit NOW, and recording a move-out frees
 * it NOW. R-009's `unit.auto_make_ready` remains the backstop for the case
 * nobody touches - a fixed term that simply runs out - and its own comment
 * already names this item as the process that would take over.
 */
export async function changeLeaseStatus(
  leaseId: string,
  to: LeaseStatusValue,
  _previous: LeaseFormState,
  formData: FormData,
): Promise<LeaseFormState> {
  const { lease, actor } = await leaseForWrite(leaseId)
  const reason = str(formData, 'reason') || null

  const decision = leaseTransition(
    {
      status: lease.status,
      tenantCount: lease.leaseTenants.length,
      rentCents: lease.rentCents,
      startsOn: lease.startsOn,
      endsOn: lease.endsOn,
      isMonthToMonth: lease.isMonthToMonth,
    },
    to,
    reason,
  )
  if (!decision.allowed) return { error: decision.message }

  const now = new Date()
  const wasInForce = leaseIsInForce(lease.status)
  const willBeInForce = leaseIsInForce(to)

  await prisma.$transaction(async (tx) => {
    await tx.lease.update({
      where: { id: leaseId },
      data: {
        status: to,
        ...(to === 'ACTIVE' && !lease.activatedAt ? { activatedAt: now } : {}),
        ...(to === 'TERMINATED' ? { terminationReason: reason } : {}),
        // Recorded on the way out, and only if nobody recorded it already -
        // a PM who logged the actual move-out date should not have it
        // overwritten by the moment they clicked the button.
        ...((to === 'ENDED' || to === 'TERMINATED') && !lease.moveOutAt
          ? { moveOutAt: now }
          : {}),
      },
    })

    if (!wasInForce && willBeInForce) {
      // Going live occupies the unit.
      await tx.unit.updateMany({
        where: { id: lease.unitId },
        data: { status: 'OCCUPIED' },
      })
    }
    if (wasInForce && !willBeInForce) {
      // Coming off. Guarded on OCCUPIED so a unit somebody has already
      // marked DOWN for a renovation is not quietly reclassified as ready
      // to turn.
      await tx.unit.updateMany({
        where: { id: lease.unitId, status: 'OCCUPIED' },
        data: { status: 'MAKE_READY' },
      })
    }

    await audit(
      {
        // TERMINATED gets its own action so `recordAudit` itself refuses a
        // termination with no reason - see REASON_REQUIRED.
        action: to === 'TERMINATED' ? 'lease.terminated' : 'lease.status_changed',
        entityType: 'Lease',
        entityId: leaseId,
        propertyId: lease.propertyId,
        before: { status: lease.status },
        after: { status: to, byStaffId: actor.id },
        ...(to === 'TERMINATED' ? { reason: reason ?? undefined } : {}),
      },
      tx,
    )
  })

  // Billing opens when the tenancy goes live (D-11, R-034). AFTER the
  // commit and never allowed to fail this action: activation is a tenancy
  // fact, and a billing provider being unreachable must not undo it. The
  // provisioner is idempotent and records its own failures, so re-running
  // the transition - or a later item's retry - is how billing catches up.
  if (!wasInForce && willBeInForce) {
    await provisionLeaseBilling(leaseId).catch((error) => {
      console.error(`[lease] billing provisioning failed for ${leaseId}`, error)
    })
  }

  revalidatePath(`/leases/${leaseId}`)
  revalidatePath('/leases')
  return { notice: 'Saved.' }
}

/**
 * Records notice to end the tenancy (LEASE-09's input, R-062's clock).
 *
 * Does NOT change the status. A tenancy under notice is still running -
 * rent is still due, repairs are still owed - and modelling notice as a
 * state would mean every "is this lease in force?" check had to remember to
 * include it. See LeaseStatus's own schema comment.
 */
export async function recordLeaseNotice(
  leaseId: string,
  _previous: LeaseFormState,
  formData: FormData,
): Promise<LeaseFormState> {
  const { lease } = await leaseForWrite(leaseId)

  const by = str(formData, 'noticeGivenBy')
  if (by !== 'TENANT' && by !== 'LANDLORD') {
    return {
      error: 'Say who gave notice.',
      fieldErrors: { noticeGivenBy: 'Tenant or landlord?' },
    }
  }
  const givenOn = str(formData, 'givenOn')
  const at = givenOn ? parseLeaseDate(givenOn) : new Date()
  if (!at) {
    return { error: 'That date could not be read.', fieldErrors: { givenOn: 'Check the date.' } }
  }

  const decision = canGiveNotice({ status: lease.status, noticeGivenAt: lease.noticeGivenAt })
  if (!decision.allowed) return { error: decision.message }

  await prisma.$transaction(async (tx) => {
    await tx.lease.update({
      where: { id: leaseId },
      data: { noticeGivenAt: at, noticeGivenBy: by as NoticePartyValue },
    })
    await audit(
      {
        action: 'lease.notice_given',
        entityType: 'Lease',
        entityId: leaseId,
        propertyId: lease.propertyId,
        after: { noticeGivenAt: at.toISOString(), noticeGivenBy: by },
      },
      tx,
    )
  })

  revalidatePath(`/leases/${leaseId}`)
  return { notice: 'Notice recorded.' }
}

export async function addLeaseTenant(
  leaseId: string,
  _previous: LeaseFormState,
  formData: FormData,
): Promise<LeaseFormState> {
  const { lease } = await leaseForWrite(leaseId)
  const tenantId = str(formData, 'tenantId')
  if (!tenantId) return { error: 'Choose who is on the lease.' }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
  if (!tenant) return { error: 'That person could not be found.' }

  const existing = await prisma.leaseTenant.count({ where: { leaseId } })

  try {
    await prisma.$transaction(async (tx) => {
      await tx.leaseTenant.create({
        data: {
          leaseId,
          tenantId,
          // The first person on a lease is the primary by default. Somebody
          // has to be the one a single-recipient message goes to, and
          // leaving every lease with no primary would make that a decision
          // taken at send time by whatever sorted first.
          isPrimary: existing === 0,
        },
      })
      await audit(
        {
          action: 'lease.party_changed',
          entityType: 'Lease',
          entityId: leaseId,
          propertyId: lease.propertyId,
          after: { added: 'tenant', tenantId, isPrimary: existing === 0 },
        },
        tx,
      )
    })
  } catch {
    // The unique (leaseId, tenantId) is the guard. Adding somebody twice is
    // a double-click, not an error worth a red banner.
    return { notice: 'They are already on this lease.' }
  }

  revalidatePath(`/leases/${leaseId}`)
  return {}
}

export async function removeLeaseTenant(
  leaseId: string,
  _previous: LeaseFormState,
  formData: FormData,
): Promise<LeaseFormState> {
  const { lease } = await leaseForWrite(leaseId)
  const leaseTenantId = str(formData, 'leaseTenantId')

  const row = await prisma.leaseTenant.findUnique({ where: { id: leaseTenantId } })
  if (!row || row.leaseId !== leaseId) return { error: 'That person is not on this lease.' }

  // A LIVE tenancy cannot be emptied. Removing the last occupant from a
  // running lease would leave rent owed by nobody and a unit occupied by
  // nobody - RISK-10's roommate-change flow is what actually handles a
  // departing tenant, and it is not this.
  if (leaseIsInForce(lease.status) && lease.leaseTenants.length <= 1) {
    return {
      error: 'A running tenancy needs at least one person on it. End the lease instead.',
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.leaseTenant.delete({ where: { id: leaseTenantId } })
    await audit(
      {
        action: 'lease.party_changed',
        entityType: 'Lease',
        entityId: leaseId,
        propertyId: lease.propertyId,
        before: { tenantId: row.tenantId, isPrimary: row.isPrimary },
        after: { removed: 'tenant', tenantId: row.tenantId },
      },
      tx,
    )
  })

  revalidatePath(`/leases/${leaseId}`)
  return {}
}

/**
 * Adds a guarantor (LEASE-06: "a distinct role: screened, financially
 * liable on the ledger, no portal access to maintenance/comms").
 *
 * The "no portal access" half needs no enforcement here and deliberately
 * has none: a Guarantor is its own model, is not a Tenant, and the portal
 * authenticates Tenants. There is no flag anybody could set wrong.
 */
export async function addGuarantor(
  leaseId: string,
  _previous: LeaseFormState,
  formData: FormData,
): Promise<LeaseFormState> {
  const { lease } = await leaseForWrite(leaseId)

  const input = {
    firstName: str(formData, 'firstName'),
    lastName: str(formData, 'lastName'),
    email: str(formData, 'email') || null,
    phone: str(formData, 'phone') || null,
  }
  const violations = validateGuarantor(input)
  if (violations.length > 0) return violationsToState(violations)

  await prisma.$transaction(async (tx) => {
    const guarantor = await tx.guarantor.create({ data: { leaseId, ...input } })
    await audit(
      {
        action: 'lease.party_changed',
        entityType: 'Lease',
        entityId: leaseId,
        propertyId: lease.propertyId,
        after: { added: 'guarantor', guarantorId: guarantor.id, name: `${input.firstName} ${input.lastName}` },
      },
      tx,
    )
  })

  revalidatePath(`/leases/${leaseId}`)
  return {}
}

/**
 * Resolves one of an inherited tenancy's outstanding items (RISK-08).
 *
 * Both facts are assertions somebody made on a date, which is why each
 * writes an audit entry rather than only a column: at move-out, "when did
 * you establish that the deposit never transferred?" is a question a
 * dispute turns on.
 */
export async function resolveIntakeItem(
  leaseId: string,
  _previous: LeaseFormState,
  formData: FormData,
): Promise<LeaseFormState> {
  const { lease } = await leaseForWrite(leaseId)
  const item = str(formData, 'item')

  if (item === 'estoppel') {
    if (lease.estoppelConfirmedAt) return { notice: 'Already confirmed.' }
    const at = new Date()
    await prisma.$transaction(async (tx) => {
      await tx.lease.update({ where: { id: leaseId }, data: { estoppelConfirmedAt: at } })
      await audit(
        {
          action: 'lease.intake_resolved',
          entityType: 'Lease',
          entityId: leaseId,
          propertyId: lease.propertyId,
          after: { item: 'estoppel', confirmedAt: at.toISOString() },
        },
        tx,
      )
    })
  } else if (item === 'deposit_transfer') {
    const status = str(formData, 'depositTransferStatus')
    if (status !== 'TRANSFERRED' && status !== 'NOT_TRANSFERRED') {
      return {
        error: 'Say what happened to the deposit.',
        fieldErrors: { depositTransferStatus: 'Transferred, or kept by the seller?' },
      }
    }
    const note = str(formData, 'depositTransferNote') || null
    await prisma.$transaction(async (tx) => {
      await tx.lease.update({
        where: { id: leaseId },
        data: { depositTransferStatus: status, depositTransferNote: note },
      })
      await audit(
        {
          action: 'lease.intake_resolved',
          entityType: 'Lease',
          entityId: leaseId,
          propertyId: lease.propertyId,
          before: { depositTransferStatus: lease.depositTransferStatus },
          after: { item: 'deposit_transfer', depositTransferStatus: status, note },
        },
        tx,
      )
    })
  } else {
    // condition_baseline is resolved by uploading a document, not by a
    // button - see the lease page's own upload form.
    return { error: 'That item is not resolved from here.' }
  }

  revalidatePath(`/leases/${leaseId}`)
  return { notice: 'Recorded.' }
}
