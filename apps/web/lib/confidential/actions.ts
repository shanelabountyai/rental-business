'use server'

import {
  BIFURCATION_REASON,
  EARLY_TERMINATION_REFUSAL_MESSAGES,
  LOCK_CHANGE_SCOPE,
  earlyTermination,
  restrictedPartyNote,
  validateConfidentialCase,
} from '@rental/core/confidential'
import {
  businessDate,
  businessDateToUtc,
  friendlyBusinessDate,
  utcToBusinessDate,
} from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission, requireScope } from '@/lib/auth/guard.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import { issueTenantLockCodeFor, revokeTenantLockCodes } from '@/lib/locks/tenant-codes.ts'
import {
  buildPartyChange,
  loadLeaseForPartyChange,
} from '@/lib/leases/party-change-builder.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { getConfidentialCase } from './queries.ts'

// Writes for confidential safety cases (RISK-04, ROLE-05; R-091).
//
// ==========================================================================
// EVERY EXPORT IS BEHIND `confidential.manage`, WHICH IS PRIVILEGED.
//
// Ordering a lock change and retiring the codes a restricted party may know
// are acts somebody's physical safety rests on, so they need a proved second
// factor - the same call R-084 makes for `hold.lift_protected` and for the
// same reason: it is not the reading that does harm, it is the doing.
//
// NOTHING HERE PUTS CASE CONTENT INTO AN AUDIT PAYLOAD. `AuditLog` is the
// table `audit.read` exists to expose broadly; an audit trail that quotes the
// record it is protecting has moved the secret rather than kept it. Every
// entry below carries the case id, and the closure reason, and nothing else.
//
// NOTHING HERE RAISES A `Task`, and that is deliberate - it is the opposite
// of the gap four consecutive items have left behind. `Task.title` is free
// text read by everyone holding `task.read`, which is the manager, the
// maintenance tech and the read-only partner, so a task saying anything
// useful about this case would be the leak, and one saying nothing useful is
// noise in somebody else's queue. The register orders open cases oldest
// first instead.
// ==========================================================================

export interface ConfidentialFormState {
  error?: string
  notice?: string
  fieldErrors?: Record<string, string>
  /// R-091c: the replacement door codes the re-key minted, shown once.
  ///
  /// RETURNED RATHER THAN READ BACK, because reading a sealed code is
  /// `accesscode.reveal` - privileged, audited, and a separate act. The
  /// person who just ordered the re-key needs these digits in their hand
  /// NOW, to read out to somebody who may be standing in front of them.
  /// Safe to render even after `revalidatePath` swaps this panel to its
  /// "ordered" branch: the component stays mounted, so its own
  /// `useActionState` result survives - unlike the door-codes panel, where
  /// the form subcomponent is what unmounts.
  newDoorCodes?: { name: string; code: string }[]
  /// Somebody who should have got a replacement and did not, because the
  /// lock refused. The loudest thing on the page while it is true.
  strandedNames?: string[]
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

async function caseForWrite(caseId: string) {
  // `requireScope` first, NEVER a resource-less `requirePermission` - an
  // empty resource only ever matches a portfolio-wide grant (see
  // `requireScope`'s own comment), so the obvious version of this refuses
  // every entity- or property-scoped owner and the whole case file stops
  // working for them. It shipped that way here and the e2e scoping test is
  // what found it.
  const { actor } = await requireScope('confidential.manage')
  const scope = await currentScope(actor)
  const found = await getConfidentialCase(caseId, scope)
  if (!found) return null
  // THEN the real authorization, against this case's own property.
  // `currentScope` is the switcher's selection; `can()` is the permission.
  await requirePermission('confidential.manage', propertyResource(found.lease.property))
  return { found, actor }
}

/**
 * Opens a case on a tenancy.
 *
 * OPENS ON A LEASE IN ANY STATE, including one already ended. The risk does
 * not stop when the tenancy does, and an operator who has just been told
 * something at 11pm should not meet a refusal because the lease ended last
 * week.
 */
export async function openConfidentialCase(
  _previous: ConfidentialFormState,
  formData: FormData,
): Promise<ConfidentialFormState> {
  const leaseId = str(formData, 'leaseId')
  if (!leaseId) return { error: 'No tenancy named.' }

  const lease = await prisma.lease.findUnique({
    where: { id: leaseId },
    select: {
      id: true,
      status: true,
      propertyId: true,
      property: { select: { id: true, legalEntityId: true, timezone: true } },
    },
  })
  if (!lease) return { error: 'That tenancy could not be found.' }
  const actor = await requirePermission('confidential.manage', propertyResource(lease.property))

  const input = {
    summary: str(formData, 'summary'),
    restrictedPartyName: str(formData, 'restrictedPartyName'),
    restrictedPartyTenantId: str(formData, 'restrictedPartyTenantId') || null,
    documentationType: str(formData, 'documentationType'),
    documentedOn: str(formData, 'documentedOn'),
    today: businessDate(new Date(), lease.property.timezone),
  }
  const violations = validateConfidentialCase(input)
  if (violations.length > 0) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.confidentialCase.create({
      data: {
        leaseId: lease.id,
        summary: input.summary,
        restrictedPartyName: input.restrictedPartyName || null,
        restrictedPartyTenantId: input.restrictedPartyTenantId,
        documentationType: input.documentationType || null,
        documentedOn: input.documentedOn ? businessDateToUtc(input.documentedOn) : null,
        documentationSeenByStaffId: input.documentationType ? actor.id : null,
        openedByStaffId: actor.id,
      },
    })
    await audit(
      {
        action: 'confidential.case_opened',
        entityType: 'ConfidentialCase',
        entityId: row.id,
        propertyId: lease.propertyId,
        // The case id and nothing else. See this file's own header.
        after: { caseId: row.id },
      },
      tx,
    )
    return row
  })

  redirect(`/confidential/${created.id}`)
}

/**
 * Records documentation, or revises the summary and the restricted party.
 *
 * Documentation is recorded here rather than demanded at opening: a survivor
 * who has not yet been to court has no order to show, and a product that
 * would not change the locks until they did would be holding somebody's
 * safety against a filing deadline.
 */
export async function updateConfidentialCase(
  caseId: string,
  _previous: ConfidentialFormState,
  formData: FormData,
): Promise<ConfidentialFormState> {
  const context = await caseForWrite(caseId)
  if (!context) return { error: 'That case no longer exists.' }
  const { found, actor } = context
  if (found.status === 'CLOSED') return { error: 'This case is closed.' }

  const input = {
    summary: str(formData, 'summary'),
    restrictedPartyName: str(formData, 'restrictedPartyName'),
    restrictedPartyTenantId: str(formData, 'restrictedPartyTenantId') || null,
    documentationType: str(formData, 'documentationType'),
    documentedOn: str(formData, 'documentedOn'),
    today: businessDate(new Date(), found.lease.property.timezone),
  }
  const violations = validateConfidentialCase(input)
  if (violations.length > 0) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.confidentialCase.update({
      where: { id: caseId },
      data: {
        summary: input.summary,
        restrictedPartyName: input.restrictedPartyName || null,
        restrictedPartyTenantId: input.restrictedPartyTenantId,
        documentationType: input.documentationType || null,
        documentedOn: input.documentedOn ? businessDateToUtc(input.documentedOn) : null,
        // Re-stamped to whoever most recently said they saw it. The person
        // who looked at the order is the fact worth holding, and the person
        // who looked at it LAST is the one still able to answer for it.
        documentationSeenByStaffId: input.documentationType ? actor.id : null,
      },
    })
    await audit(
      {
        action: 'confidential.case_updated',
        entityType: 'ConfidentialCase',
        entityId: caseId,
        propertyId: found.lease.propertyId,
        // Which FIELDS changed, never their values.
        after: {
          caseId,
          documentationRecorded: Boolean(input.documentationType),
          restrictedPartyNamed: Boolean(input.restrictedPartyName),
        },
      },
      tx,
    )
  })

  revalidatePath(`/confidential/${caseId}`)
  return { notice: 'Case updated.' }
}

/**
 * Orders the re-key, and retires the access codes on file.
 *
 * TWO ACTS IN ONE BUTTON, because they are one decision and separating them
 * is how the second gets forgotten. The work order changes the physical
 * locks; retiring the codes stops THIS SYSTEM handing out a code the
 * restricted party may already know - to a vendor through
 * `revealAccessCode`, or to a tenant through `issueAccessCodeToTenant`.
 *
 * RETIRING A CODE CHANGES NO LOCK. It closes out our record so nothing here
 * discloses it again; the work order is what makes the door different. The
 * page says so, because an operator who believed otherwise would stop after
 * this and think the unit was secure.
 */
export async function orderLockChange(
  caseId: string,
  _previous: ConfidentialFormState,
  formData: FormData,
): Promise<ConfidentialFormState> {
  const context = await caseForWrite(caseId)
  if (!context) return { error: 'That case no longer exists.' }
  const { found, actor } = context
  if (found.lockChangeWorkOrderId) {
    return { error: 'A re-key has already been ordered from this case.' }
  }

  const callbackLabel = str(formData, 'callbackLabel')
  if (!callbackLabel) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: {
        callbackLabel:
          'Give the name and number the locksmith should ring if anybody else asks about this job.',
      },
    }
  }

  // Who MAY be handed keys: whoever is on the tenancy, minus the restricted
  // party if they are one of them. Never a list of who may not - see
  // `restrictedPartyNote`'s own comment.
  const authorizedNames = found.lease.leaseTenants
    .filter((lt) => lt.tenant.id !== found.restrictedPartyTenantId)
    .map((lt) => `${lt.tenant.firstName} ${lt.tenant.lastName}`)

  const note = restrictedPartyNote({ authorizedNames, callbackLabel })

  // R-091c. Who KEEPS a way in: whoever is on the tenancy, minus the
  // restricted party if they are one of them - the same list the locksmith's
  // note is built from, and deliberately the same expression, so the person
  // who may be handed keys and the person who gets a new door code can never
  // be two different answers.
  const stillAuthorized = found.lease.leaseTenants
    .filter((lt) => lt.tenant.id !== found.restrictedPartyTenantId)
    .map((lt) => ({
      id: lt.tenant.id,
      name: `${lt.tenant.firstName} ${lt.tenant.lastName}`,
    }))

  const workOrderId = await prisma.$transaction(async (tx) => {
    const workOrder = await tx.workOrder.create({
      data: {
        propertyId: found.lease.propertyId,
        unitId: found.lease.unitId,
        // URGENT, not EMERGENCY. Emergency is R-029's after-hours paging
        // tier, and a page that wakes a rota carries text into SMS and
        // voicemail on several phones - the widest possible surface for a
        // job whose whole point is that it is not discussed. Urgent puts it
        // at the top of the queue without broadcasting it.
        priority: 'URGENT',
        scope: LOCK_CHANGE_SCOPE,
        restrictedPartyNote: note,
      },
    })
    await tx.confidentialCase.update({
      where: { id: caseId },
      data: { lockChangeWorkOrderId: workOrder.id },
    })
    // The ordinary, readable record that a job exists. Says nothing about a
    // case - this is the entry a dispatcher's audit view would show.
    await audit(
      {
        action: 'workorder.created',
        entityType: 'WorkOrder',
        entityId: workOrder.id,
        propertyId: found.lease.propertyId,
        after: { scope: workOrder.scope, priority: workOrder.priority, ticketId: null },
      },
      tx,
    )
    await audit(
      {
        action: 'confidential.lock_change_ordered',
        entityType: 'ConfidentialCase',
        entityId: caseId,
        propertyId: found.lease.propertyId,
        after: { caseId, workOrderId: workOrder.id },
      },
      tx,
    )

    // R-091c. THE SMART LOCK, WHERE THERE IS ONE - and this is the half
    // R-091 could not do, because no lock existed then. Retiring an
    // `AccessCode` row closes our record; it changes no lock, which R-091's
    // own panel says in as many words. A door code IS the lock, so the
    // restricted party keeps working access until the locksmith arrives
    // unless it is revoked here.
    //
    // EVERYBODY'S, NOT JUST THE RESTRICTED PARTY'S, for the reason the
    // whole re-key exists: households share codes, and a restricted party
    // who was told the survivor's code walks in on the survivor's code. This
    // is the digital half of changing the locks, so it changes all of them.
    await revokeTenantLockCodes(
      { leaseId: found.lease.id },
      { reason: 'The locks are being changed.', staffId: actor.id },
      tx,
    ).then(async (revoked) => {
      if (revoked.length === 0) return
      // On the LEASE, readable, and saying nothing: a door code changing is
      // an ordinary fact about a tenancy, and the reason above names no
      // person and no cause (D-107).
      await audit(
        {
          action: 'accesscode.tenant_code_revoked',
          entityType: 'Lease',
          entityId: found.lease.id,
          propertyId: found.lease.propertyId,
          reason: 'The locks are being changed.',
          after: {
            codeIds: revoked.map((code) => code.id),
            reachedDevice: revoked.every((code) => code.reachedDevice),
          },
        },
        tx,
      )
    })

    // Every code still open-ended on this unit. `effectiveTo` is R-005's own
    // retirement mechanism (see `addAccessCode`), reused rather than a second
    // notion of "retired" - a code with an end date is already what every
    // reader here means by "no longer current".
    const live = await tx.accessCode.findMany({
      where: { unitId: found.lease.unitId, effectiveTo: null },
      select: { id: true },
    })
    if (live.length > 0) {
      await tx.accessCode.updateMany({
        where: { id: { in: live.map((c) => c.id) } },
        data: { effectiveTo: new Date() },
      })
      await audit(
        {
          action: 'confidential.codes_retired',
          entityType: 'ConfidentialCase',
          entityId: caseId,
          propertyId: found.lease.propertyId,
          // How many, never which.
          after: { caseId, unitId: found.lease.unitId, retiredCount: live.length },
        },
        tx,
      )
    }
    return workOrder.id
  })

  // ==========================================================================
  // R-091c. THE REPLACEMENT CODES, AFTER THE COMMIT AND NEVER INSIDE IT.
  //
  // Revoking is the safety act and it must not be held up by anything;
  // minting is a call to a third party that can fail. If this fails the
  // tenancy is CODE-LESS, which is a survivor locked out of their own home
  // at night - the exact failure D-118 refuses to build an auto-expiring
  // tenant code for - so it is never silent: the names come back and the
  // page says them in red.
  //
  // NO FUNDS GATE AND NO HOLD GATE, unlike `issueTenantLockCode`. Those
  // guard a MOVE-IN, which is a decision about whether somebody is entitled
  // to possession yet. This is a sitting tenant whose code was just killed
  // for their own safety, and refusing to give it back because a deposit has
  // not cleared would be the product getting the situation exactly backwards.
  // That is why the gates live in the action and not in the module.
  // ==========================================================================
  const newDoorCodes: { name: string; code: string }[] = []
  const strandedNames: string[] = []
  for (const person of stillAuthorized) {
    const result = await issueTenantLockCodeFor({
      leaseId: found.lease.id,
      tenantId: person.id,
      staffId: actor.id,
    })
    if (result.refusal === 'no_smart_lock') break
    if (result.refusal) {
      strandedNames.push(person.name)
      continue
    }
    newDoorCodes.push({ name: person.name, code: result.issued.code })
    await audit({
      action: 'accesscode.issued',
      entityType: 'Lease',
      entityId: found.lease.id,
      propertyId: found.lease.propertyId,
      after: {
        tenantLockCodeId: result.issued.id,
        tenantId: person.id,
        programmedAtDevice: true,
      },
    })
  }

  if (newDoorCodes.length > 0 || strandedNames.length > 0) {
    // On the CASE side, and counts only - how many, never which, the same
    // call `confidential.codes_retired` already makes (D-107). Its OWN
    // action, not a second one of those: retiring an `AccessCode` closes our
    // record and changes no lock, and this changes the door.
    await audit({
      action: 'confidential.door_codes_reissued',
      entityType: 'ConfidentialCase',
      entityId: caseId,
      propertyId: found.lease.propertyId,
      after: {
        caseId,
        unitId: found.lease.unitId,
        doorCodesReissued: newDoorCodes.length,
        doorCodesStranded: strandedNames.length,
      },
    })
  }

  revalidatePath(`/confidential/${caseId}`)
  revalidatePath(`/leases/${found.lease.id}`)
  return {
    notice: `Re-key ordered as work order ${workOrderId.slice(-6)}. Assign it to a locksmith from the work-order queue.`,
    newDoorCodes: newDoorCodes.length > 0 ? newDoorCodes : undefined,
    strandedNames: strandedNames.length > 0 ? strandedNames : undefined,
  }
}

/**
 * Closes the case. REASON_REQUIRED - a decision that a safety risk has passed
 * is the one somebody asks about afterwards, and it is the only case content
 * that crosses into `AuditLog`.
 */
export async function closeConfidentialCase(
  caseId: string,
  _previous: ConfidentialFormState,
  formData: FormData,
): Promise<ConfidentialFormState> {
  const context = await caseForWrite(caseId)
  if (!context) return { error: 'That case no longer exists.' }
  const { found } = context
  if (found.status === 'CLOSED') return { error: 'This case is already closed.' }

  const closedNote = str(formData, 'closedNote')
  if (!closedNote) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: { closedNote: 'Say how this ended.' },
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.confidentialCase.update({
      where: { id: caseId },
      data: { status: 'CLOSED', closedAt: new Date(), closedNote },
    })
    await audit(
      {
        action: 'confidential.case_closed',
        entityType: 'ConfidentialCase',
        entityId: caseId,
        propertyId: found.lease.propertyId,
        reason: closedNote,
        after: { caseId },
      },
      tx,
    )
  })

  revalidatePath(`/confidential/${caseId}`)
  return { notice: 'Case closed.' }
}

// ---------------------------------------------------------------------------
// R-091b: the statutory right, and the removal
// ---------------------------------------------------------------------------

/**
 * Records the tenancy's early termination under this state's statute.
 *
 * ==========================================================================
 * ITS OWN ACTION RATHER THAN A FLAG ON `recordLeaseNotice`, for the reasons
 * `recordScraTermination` gives and one more.
 *
 *   * The state's `noticeToVacateDays` does not apply. The early-termination
 *     statute is what governs this date; treating the ordinary notice period
 *     as a floor would demand an override reason from somebody exercising a
 *     statutory right, which is D-82's objection to §3955 running through
 *     `noticePeriodCheck`, arriving from a different statute.
 *   * Just cause and retaliation do not apply: the tenant is ending their own
 *     tenancy.
 *   * The effective date is COMPUTED from configuration, not typed.
 *   * And the one that is new here: the reason must not reach the tenancy.
 *     An SCRA termination writes `Lease.scraTerminationBasis`, which is safe
 *     because being a servicemember is not a secret. There is no equivalent
 *     column here and there must not be: a `Lease` column naming this basis
 *     would be readable by everybody holding `lease.read` and would be the
 *     disclosure (D-107). What the tenancy shows is R-066's ordinary
 *     tenant-given notice; that the right was claimed is recorded HERE,
 *     behind the wall.
 * ==========================================================================
 */
export async function recordEarlyTermination(
  caseId: string,
  _previous: ConfidentialFormState,
  formData: FormData,
): Promise<ConfidentialFormState> {
  const context = await caseForWrite(caseId)
  if (!context) return { error: 'That case no longer exists.' }
  const { found } = context
  // Ending a tenancy is a lease act whatever the reason for it. An actor who
  // could not record a notice on the lease page must not be able to record
  // one from here either.
  await requirePermission('lease.write', propertyResource(found.lease.property))

  if (found.earlyTerminationRecordedAt) {
    return { error: 'An early termination has already been recorded from this case.' }
  }

  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: found.lease.id },
    select: { id: true, status: true, noticeGivenAt: true },
  })
  if (lease.status !== 'ACTIVE' && lease.status !== 'MONTH_TO_MONTH') {
    return { error: 'Only a running tenancy can be terminated early.' }
  }
  if (lease.noticeGivenAt) {
    return {
      error:
        'Notice has already been recorded on this tenancy. Clearing it and starting again is a lease edit, not a second notice.',
    }
  }

  const zone = found.lease.property.timezone
  const deliveredOn = str(formData, 'deliveredOn')
  const forwardingAddress = str(formData, 'forwardingAddress') || null
  if (!deliveredOn) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: { deliveredOn: 'When did they give written notice?' },
    }
  }

  // An unconfigured state reaches `earlyTermination` as `rightExists: null`
  // rather than throwing, so the operator gets the sentence that says what to
  // do instead of a 500. Failing OPEN in the sense that matters: nothing
  // about the case, the lock change or the retired codes waits on this.
  const rule = await rulesFor(
    { state: found.lease.property.state, county: found.lease.property.county },
    businessDateToUtc(deliveredOn),
  ).catch(() => null)

  const decision = earlyTermination({
    deliveredOn,
    today: businessDate(new Date(), zone),
    rule: {
      rightExists: rule?.earlyTerminationRightExists ?? null,
      noticeDays: rule?.earlyTerminationNoticeDays ?? null,
      acceptedDocumentationTypes: rule?.earlyTerminationDocumentationTypes ?? [],
    },
    // FROM THE CASE, NEVER FROM THIS FORM (D-108). What the statute turns on
    // is that documentation of an accepted class was produced, which the case
    // already records whole - type, date and who saw it - under a database
    // CHECK. A second copy typed here would be a second answer to the same
    // question.
    documentationType: found.documentationType,
    documentedOn: found.documentedOn ? utcToBusinessDate(found.documentedOn) : null,
  })
  if (decision.refusal) {
    return { error: EARLY_TERMINATION_REFUSAL_MESSAGES[decision.refusal] }
  }

  await prisma.$transaction(async (tx) => {
    await tx.lease.update({
      where: { id: lease.id },
      data: {
        // A tenant-given notice, because that is what it is (R-066). No
        // basis column, deliberately - see this function's own header.
        noticeGivenAt: businessDateToUtc(deliveredOn),
        noticeGivenBy: 'TENANT',
        noticeEffectiveOn: businessDateToUtc(decision.effectiveOn),
        noticeForwardingAddress: forwardingAddress,
      },
    })
    await tx.confidentialCase.update({
      where: { id: caseId },
      data: { earlyTerminationRecordedAt: new Date() },
    })
    // The ordinary, readable entry every other notice writes. It carries no
    // basis, no statute and no case - the tenancy's trail shows a tenant who
    // gave notice, which is true and is all of it that is anybody else's.
    await audit(
      {
        action: 'lease.notice_given',
        entityType: 'Lease',
        entityId: lease.id,
        propertyId: found.lease.propertyId,
        after: {
          noticeGivenAt: businessDateToUtc(deliveredOn).toISOString(),
          noticeGivenBy: 'TENANT',
          effectiveOn: businessDateToUtc(decision.effectiveOn).toISOString(),
        },
      },
      tx,
    )
    await audit(
      {
        action: 'confidential.early_termination_recorded',
        entityType: 'ConfidentialCase',
        entityId: caseId,
        propertyId: found.lease.propertyId,
        after: { caseId },
      },
      tx,
    )
  })

  revalidatePath(`/confidential/${caseId}`)
  revalidatePath(`/leases/${found.lease.id}`)
  return {
    notice: `Recorded. The tenancy ends on ${friendlyBusinessDate(decision.effectiveOn)} — ${decision.noticeDays} days from the notice. The tenancy shows an ordinary tenant-given notice and nothing else.`,
  }
}

/**
 * Sends the amendment that takes the restricted party off the tenancy.
 *
 * ==========================================================================
 * THE ONLY CALLER THAT CAN BUILD A PARTY CHANGE NOBODY IS ASKED TO SIGN, and
 * it is one of exactly two entry points into the same builder. The other is
 * the lease page's ordinary panel, which passes `unsigned: null` and has no
 * way to pass anything else. A "skip signatures" checkbox on that panel would
 * have been the same feature reachable by the ordinary permission and offered
 * to every operator doing a roommate swap.
 *
 * THE REASON IS A FIXED STRING. The ordinary path takes free text and should;
 * here the same field is printed on a document every signer reads, archived
 * as a `Document` that `document.read` puts in front of the maintenance tech,
 * and copied into `lease.party_changed` - so a box an operator types into is
 * an invitation to disclose (D-107).
 *
 * IT REMOVES SOMEBODY FROM A LEASE, NOT FROM A HOUSE. The panel says so in
 * as many words, because acting on this alone would be a self-help eviction.
 * ==========================================================================
 */
export async function startConfidentialBifurcation(
  caseId: string,
  _previous: ConfidentialFormState,
  formData: FormData,
): Promise<ConfidentialFormState> {
  const context = await caseForWrite(caseId)
  if (!context) return { error: 'That case no longer exists.' }
  const { found } = context

  if (found.partyChangeId) {
    return { error: 'An amendment has already been sent from this case.' }
  }
  if (!found.restrictedPartyTenantId) {
    return {
      error:
        'This case does not name the restricted party as somebody on the tenancy, so there is nobody here to remove. Name them on the case first — and if they were never on the lease, there is nothing to amend.',
    }
  }

  // `lease.execute`, checked inside. Loaded after the case checks so that an
  // actor without it is refused before anything is generated.
  const { lease, actor } = await loadLeaseForPartyChange(found.lease.id)

  const effectiveOn = str(formData, 'effectiveOn')
  if (!effectiveOn) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: { effectiveOn: 'When does the removal take effect?' },
    }
  }

  const result = await buildPartyChange({
    lease,
    actorId: actor.id,
    outgoingTenantIds: [found.restrictedPartyTenantId],
    incomingApplicantIds: [],
    effectiveOn,
    reason: BIFURCATION_REASON,
    // No warning can arise here: the household-income warning needs an
    // incoming party and there is never one on this path.
    acknowledgedWarnings: true,
    unsigned: { tenantIds: [found.restrictedPartyTenantId] },
  })
  if (!result.changeId) {
    const { changeId: _unused, ...state } = result
    return state
  }

  await prisma.$transaction(async (tx) => {
    await tx.confidentialCase.update({
      where: { id: caseId },
      data: { partyChangeId: result.changeId },
    })
    await audit(
      {
        action: 'confidential.party_change_started',
        entityType: 'ConfidentialCase',
        entityId: caseId,
        propertyId: found.lease.propertyId,
        after: { caseId, changeId: result.changeId },
      },
      tx,
    )
  })

  revalidatePath(`/confidential/${caseId}`)
  revalidatePath(`/leases/${found.lease.id}`)
  return {
    error: result.error,
    notice: result.error
      ? undefined
      : 'Amendment sent. The person being removed is not asked to sign it and is not sent a link.',
  }
}
