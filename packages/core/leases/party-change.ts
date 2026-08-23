import type { DocumentBlock } from '../documents/blocks.ts'
import { LEASE_DISCLAIMER, type LeaseSignatureFact } from './generation.ts'
import { leaseIsInForce } from './status.ts'

// Roommate changes and lease assignment (RISK-10, R-090).
//
// ONE MECHANISM COVERS BOTH, which is why the backlog row names them
// together. A roommate leaving and being replaced, a roommate joining, and a
// whole tenancy being assigned to somebody new are the same operation with
// different party lists: some people come off the lease, some go on, the
// LEASE ITSELF DOES NOT CHANGE. Everything else RISK-10 asks for follows
// from keeping the same Lease row - see the migration's own header, which
// works through why "ledger continuity" and "the deposit stays with the
// unit" both turn out to be things NOT to build rather than things to build.
//
// THERE IS NO MONEY IN THIS FILE. Not a cents field, not a proration, not a
// settlement. That is RISK-10's hard rule enforced the only way it can
// actually be enforced: departing roommates settle their share between
// themselves, and no code path here can pay one of them anything.

export interface PartyChangeViolation {
  field: string
  message: string
}

export interface PartyChangeWarning {
  key: 'household_income'
  message: string
}

export interface PartyChangePartyInput {
  tenantId: string
  name: string
  /// INCOMING only. Enforced NOT NULL for an incoming party by a database
  /// CHECK as well - see the migration.
  applicantId?: string | null
  /// INCOMING only: whether that applicant's screening reached a decision,
  /// and which. Null means no ScreeningReport exists at all.
  screeningDecision?: 'APPROVED' | 'DECLINED' | 'CONDITIONAL' | null
  monthlyIncomeCents?: number | null
}

export interface PartyChangeInput {
  leaseStatus: string
  /// Every tenant currently on the lease.
  currentTenantIds: readonly string[]
  outgoing: readonly PartyChangePartyInput[]
  incoming: readonly PartyChangePartyInput[]
  /// `YYYY-MM-DD`, property-local. A BusinessDate, never a Date - this is a
  /// calendar day and no timezone may touch it (CLAUDE.md's `@db.Date` rule).
  effectiveOn: string
  leaseStartsOn: string
  leaseEndsOn: string | null
  reason: string
}

export interface PartyChangeAssessment {
  violations: PartyChangeViolation[]
  warnings: PartyChangeWarning[]
  /// Who is on the lease once this completes. The count is what the
  /// "a tenancy cannot be emptied" rule is checked against, and the list is
  /// what the amendment prints.
  remainingTenantIds: string[]
}

/**
 * Whether this change can be sent for signature at all.
 *
 * REFUSALS ARE VIOLATIONS; JUDGEMENT CALLS ARE WARNINGS. The two that block
 * are structural - a tenancy with nobody on it, and a replacement nobody
 * screened - and neither is a matter of opinion. Whether the remaining
 * household still earns enough is a real question with a legitimate "yes,
 * approve it anyway" answer (the leaving roommate was not the earner; a
 * guarantor is already on the lease; the owner knows these people), so it
 * is surfaced and left to the person, the same posture R-089's
 * below-deductible warning takes.
 */
export function assessPartyChange(
  input: PartyChangeInput,
  criteria: { incomeToRentMultiplierX100: number; rentCents: number } | null,
): PartyChangeAssessment {
  const violations: PartyChangeViolation[] = []
  const warnings: PartyChangeWarning[] = []

  const outgoingIds = new Set(input.outgoing.map((p) => p.tenantId))
  const remainingTenantIds = [
    ...input.currentTenantIds.filter((id) => !outgoingIds.has(id)),
    ...input.incoming.map((p) => p.tenantId),
  ]

  if (!leaseIsInForce(input.leaseStatus)) {
    violations.push({
      field: 'lease',
      message: 'Only a running tenancy can change who is on it.',
    })
  }

  if (input.outgoing.length === 0 && input.incoming.length === 0) {
    violations.push({ field: 'parties', message: 'Name at least one person joining or leaving.' })
  }

  for (const party of input.outgoing) {
    if (!input.currentTenantIds.includes(party.tenantId)) {
      violations.push({ field: 'outgoing', message: `${party.name} is not on this lease.` })
    }
  }

  for (const party of input.incoming) {
    if (input.currentTenantIds.includes(party.tenantId)) {
      violations.push({ field: 'incoming', message: `${party.name} is already on this lease.` })
      continue
    }
    // RISK-10's "screened to full criteria". A replacement roommate is a new
    // tenant, and a new tenant who was not held to the same written criteria
    // as everybody else is the fair-housing exposure the whole screening
    // module exists to avoid - so this refuses rather than warns, and there
    // is deliberately no override.
    if (!party.applicantId) {
      violations.push({
        field: 'incoming',
        message: `${party.name} has no application on file. A replacement is screened to the same criteria as any other applicant.`,
      })
    } else if (party.screeningDecision == null) {
      violations.push({
        field: 'incoming',
        message: `${party.name}'s screening has not been decided yet.`,
      })
    } else if (party.screeningDecision === 'DECLINED') {
      violations.push({
        field: 'incoming',
        message: `${party.name} was declined. Adverse action has its own path (R-061); they cannot be added here.`,
      })
    }
  }

  // A LIVE tenancy cannot be emptied. If everybody is leaving and nobody is
  // joining, the thing being described is the END of the tenancy, not a
  // change of parties, and it has its own flow with its own deposit
  // disposition and its own notice periods.
  if (remainingTenantIds.length === 0 && input.outgoing.length > 0) {
    violations.push({
      field: 'parties',
      message:
        'This would leave nobody on the tenancy. Ending the lease is a different thing to a change of roommates — end it instead.',
    })
  }

  if (!input.reason.trim()) {
    violations.push({ field: 'reason', message: 'Say why the parties are changing.' })
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveOn)) {
    violations.push({ field: 'effectiveOn', message: 'Give the date this takes effect.' })
  } else {
    if (input.effectiveOn < input.leaseStartsOn) {
      violations.push({
        field: 'effectiveOn',
        message: `The tenancy did not start until ${input.leaseStartsOn}.`,
      })
    }
    if (input.leaseEndsOn && input.effectiveOn > input.leaseEndsOn) {
      violations.push({
        field: 'effectiveOn',
        message: `The term ends ${input.leaseEndsOn}. A change after that is a new tenancy, not an amendment.`,
      })
    }
  }

  // The household test, advisory. Only counts income actually on file:
  // somebody who never reported a figure contributes nothing here, which
  // understates rather than overstates - the safe direction for a warning.
  if (criteria && input.outgoing.length > 0 && input.incoming.length > 0) {
    const required = Math.ceil((criteria.rentCents * criteria.incomeToRentMultiplierX100) / 100)
    const known = input.incoming.filter((p) => p.monthlyIncomeCents != null)
    if (known.length > 0) {
      const incomingIncome = known.reduce((sum, p) => sum + (p.monthlyIncomeCents ?? 0), 0)
      if (incomingIncome < required) {
        warnings.push({
          key: 'household_income',
          message: `The replacement's own reported income is under ${(criteria.incomeToRentMultiplierX100 / 100).toFixed(2)}x rent on their own. Everybody on the lease stays jointly liable for the whole rent.`,
        })
      }
    }
  }

  return { violations, warnings, remainingTenantIds }
}

// ---------------------------------------------------------------------------
// The amendment document
// ---------------------------------------------------------------------------

/// Printed on every party-change amendment, verbatim. RISK-10's hard rule,
/// stated to the people it binds rather than only enforced in code they
/// never see: the departing roommate's question is "when do I get my share
/// of the deposit back", and the answer has to be in the document they
/// signed, not discovered at move-out.
export const DEPOSIT_STAYS_WITH_UNIT =
  'The security deposit stays with the unit. No part of it is refunded, transferred or re-accounted for because of this change. It remains held against the tenancy as a whole and is dealt with once, after the last occupant has moved out. Any settlement between a departing occupant and those remaining is a private matter between them, and the landlord is not a party to it.'

/// The other half of what an amendment has to say, and the half that is easy
/// to leave out: everything the amendment does NOT change is still in force.
/// A document that lists only what moved invites the reading that the rest
/// was renegotiated.
export const OTHERWISE_UNCHANGED =
  'Every other term of the lease — the rent, the due date, the term dates, the deposit held, and every addendum — is unchanged and remains in full force. This amendment changes only who is a party to the lease, from the effective date above.'

/// What a departing occupant is and is not released from. The distinction
/// costs nothing to state and is the one a later collection turns on: a
/// release running backwards would wipe out arrears that accrued while they
/// lived there, which is not what anybody agreed to.
export const RELEASE_IS_PROSPECTIVE =
  'A departing occupant is released from obligations arising on and after the effective date. They remain liable for everything that accrued while they were a party to the lease, including any unpaid rent, fees or damage arising before that date.'

export interface AmendmentDocumentFacts {
  propertyName: string
  propertyAddress: string
  unitName: string
  entityName: string
  effectiveOn: string
  generatedOn: string
  reason: string
  rentAmount: string
  depositAmount: string
  termStartsOn: string
  termEndsOn: string | null
  outgoingNames: readonly string[]
  incomingNames: readonly string[]
  remainingNames: readonly string[]
  signers: readonly LeaseSignatureFact[]
}

/**
 * The amendment everybody signs - the departing occupant, everybody staying,
 * the replacement, and every guarantor.
 *
 * ONE DOCUMENT, NOT TWO. RISK-10 names a "departing-tenant release form" and
 * an "amendment e-signed by all", and the tempting build is two envelopes.
 * They are the same paper: the release is a clause, and a release signed
 * only by the person being released is the weakest possible version of it -
 * what makes it hold is that the remaining occupants agreed to it too.
 * Splitting them would double the machinery and halve the evidence.
 *
 * A GUARANTOR SIGNS. Their guarantee was of a particular household, and
 * swapping a party to the lease without asking them is how a guarantee gets
 * argued away later.
 */
export function amendmentDocumentBlocks(facts: AmendmentDocumentFacts): DocumentBlock[] {
  const blocks: DocumentBlock[] = [
    { kind: 'heading', text: 'Amendment to Residential Lease — Change of Occupants' },
  ]

  blocks.push({ kind: 'meta', text: `Date prepared: ${facts.generatedOn}` })
  blocks.push({ kind: 'meta', text: `Effective: ${facts.effectiveOn}` })
  blocks.push({ kind: 'meta', text: `Property: ${facts.propertyName} — ${facts.unitName}` })
  blocks.push({ kind: 'meta', text: `Address: ${facts.propertyAddress}` })
  blocks.push({ kind: 'meta', text: `Landlord: ${facts.entityName}` })
  blocks.push({
    kind: 'meta',
    text: `Lease term: ${facts.termStartsOn} to ${facts.termEndsOn ?? 'month-to-month'}`,
  })
  blocks.push({ kind: 'meta', text: `Rent (unchanged): ${facts.rentAmount}` })
  blocks.push({ kind: 'meta', text: `Security deposit held (unchanged): ${facts.depositAmount}` })

  blocks.push({
    kind: 'paragraph',
    text: `The parties to the lease described above agree to amend it as set out below, effective ${facts.effectiveOn}. Reason recorded: ${facts.reason}`,
  })

  if (facts.outgoingNames.length > 0) {
    blocks.push({ kind: 'subheading', text: 'Occupants leaving the lease' })
    for (const name of facts.outgoingNames) {
      blocks.push({ kind: 'meta', text: name })
    }
    blocks.push({ kind: 'paragraph', text: RELEASE_IS_PROSPECTIVE })
  }

  if (facts.incomingNames.length > 0) {
    blocks.push({ kind: 'subheading', text: 'Occupants joining the lease' })
    for (const name of facts.incomingNames) {
      blocks.push({ kind: 'meta', text: name })
    }
    blocks.push({
      kind: 'paragraph',
      text: 'Each occupant joining accepts every term of the lease as if originally named in it, and is jointly and severally liable with the other occupants for the whole of the rent and every other obligation under it.',
    })
  }

  blocks.push({ kind: 'subheading', text: 'Occupants after this amendment' })
  for (const name of facts.remainingNames) {
    blocks.push({ kind: 'meta', text: name })
  }

  blocks.push({ kind: 'subheading', text: 'The security deposit' })
  blocks.push({ kind: 'paragraph', text: DEPOSIT_STAYS_WITH_UNIT })

  blocks.push({ kind: 'subheading', text: 'Everything else' })
  blocks.push({ kind: 'paragraph', text: OTHERWISE_UNCHANGED })

  blocks.push({ kind: 'subheading', text: 'Signatures' })
  for (const signer of facts.signers) {
    const label = signer.role === 'TENANT' ? 'Occupant' : 'Guarantor'
    blocks.push({
      kind: 'meta',
      text: signer.signedAt
        ? `${label} ${signer.order}: ${signer.signedName ?? signer.name} — signed electronically ${signer.signedAt}`
        : `${label} ${signer.order}: ${signer.name} — not yet signed`,
    })
  }

  blocks.push({ kind: 'footer', text: LEASE_DISCLAIMER })

  return blocks
}
