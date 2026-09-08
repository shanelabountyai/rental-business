import type { Cents } from '../money/money.ts'
import type { BusinessDate } from '../scheduling/local-time.ts'

// What settled into the shared Stripe balance, split by the LLC whose houses
// earned it (PROP-02/RPT-05, review finding 12, R-180).
//
// ==========================================================================
// THE PROBLEM THIS EXISTS INSIDE. There is one `STRIPE_SECRET_KEY` for the
// deployment and no `stripeAccount`, `on_behalf_of` or `transfer_data`
// anywhere, so every dollar of online rent for every property in every LLC
// settles into ONE Stripe balance and one bank account. Commingling is the
// specific thing an LLC structure exists to prevent, and the entity boundary
// this product otherwise takes seriously - R-081a's operating snapshot,
// R-081b/d's tax packet, D-168's entity-bounded deposit slips - stops
// precisely at the money.
//
// A connected account per entity is the real answer and is deliberately not
// this module (it changes every payment path and needs a legal-structure
// decision nobody has taken). What this does is tell the owner what each
// entity's share of the shared account is, for a date range, so the funds
// can be moved deliberately and the movement argued from afterwards.
//
// THE ARITHMETIC IS SIGNED, AND THAT IS THE WHOLE CORRECTNESS OF IT. A
// payment that settled in March and was returned in April was genuinely in
// March's payouts and is genuinely out of April's. Summing only rows that
// are currently SETTLED gets that wrong twice: March loses money it really
// received, and April never shows the clawback at all. So a settlement and
// a reversal are two separate dated events off the same row, each counted in
// whichever window it falls in, and a row can appear in both.
//
// GROSS, NEVER NET. Nothing in this product records a Stripe processing fee -
// there is no column for one and no event that carries one - so these totals
// are what the payer sent, not what reached the bank. The caller says so on
// screen; a fee estimated here would be a number wearing a fact's costume.
// ==========================================================================

export interface SettlementPayment {
  id: string
  legalEntityId: string
  propertyId: string
  amountCents: Cents
  /// Property-local calendar day the money settled into the Stripe balance.
  /// The caller reads it through the PROPERTY's zone (R-042) - a payment at
  /// 11pm on the last of the month in Texas belongs to that month.
  settledOn: BusinessDate
  /// Property-local calendar day it was taken back out, null while it stands.
  reversedOn: BusinessDate | null
}

export interface SettlementPropertyLine {
  propertyId: string
  settledCents: Cents
  reversedCents: Cents
  netCents: Cents
}

export interface EntitySettlement {
  legalEntityId: string
  /// Money in, for settlements dated inside the window. Positive.
  settledCents: Cents
  /// Money back out, for reversals dated inside the window. Positive - it is
  /// subtracted below rather than carried as a negative, so a reader can see
  /// both halves instead of one blended figure that hides a bad month.
  reversedCents: Cents
  /// What this entity is owed out of the shared account for the window.
  netCents: Cents
  properties: SettlementPropertyLine[]
  paymentIds: readonly string[]
}

export interface SettlementSummary {
  entities: EntitySettlement[]
  /// What the shared bank account received across every entity. The number a
  /// bank line is compared against - before fees, see the header.
  netCents: Cents
  settledCents: Cents
  reversedCents: Cents
}

function inWindow(day: BusinessDate, from: BusinessDate, to: BusinessDate): boolean {
  // `YYYY-MM-DD` sorts lexicographically as it sorts chronologically, which
  // is the whole reason BusinessDate is a string. Both ends inclusive: a
  // reader who types 1st to 31st means the 31st.
  return day >= from && day <= to
}

/**
 * Every entity's share of what settled in `[from, to]`, largest net first.
 *
 * Entities with no activity in the window are absent rather than zero. A
 * zero row here would read as "this LLC collected nothing", which is a
 * claim; absence is the honest shape, and the caller lists the entities it
 * asked about separately.
 */
export function summariseSettlements(
  payments: readonly SettlementPayment[],
  window: { from: BusinessDate; to: BusinessDate },
): SettlementSummary {
  const entities = new Map<
    string,
    Omit<EntitySettlement, 'properties' | 'paymentIds'> & {
      properties: Map<string, SettlementPropertyLine>
      paymentIds: string[]
    }
  >()

  const entityFor = (payment: SettlementPayment) => {
    let entity = entities.get(payment.legalEntityId)
    if (!entity) {
      entity = {
        legalEntityId: payment.legalEntityId,
        settledCents: 0,
        reversedCents: 0,
        netCents: 0,
        properties: new Map(),
        paymentIds: [],
      }
      entities.set(payment.legalEntityId, entity)
    }
    let property = entity.properties.get(payment.propertyId)
    if (!property) {
      property = { propertyId: payment.propertyId, settledCents: 0, reversedCents: 0, netCents: 0 }
      entity.properties.set(payment.propertyId, property)
    }
    return { entity, property }
  }

  for (const payment of payments) {
    const settledHere = inWindow(payment.settledOn, window.from, window.to)
    const reversedHere = payment.reversedOn != null && inWindow(payment.reversedOn, window.from, window.to)
    // A row whose settlement AND reversal both fall outside the window
    // contributes nothing and must not create an entity line - see the
    // docstring on why a zero row is a claim.
    if (!settledHere && !reversedHere) continue

    const { entity, property } = entityFor(payment)
    entity.paymentIds.push(payment.id)
    if (settledHere) {
      entity.settledCents += payment.amountCents
      property.settledCents += payment.amountCents
    }
    if (reversedHere) {
      entity.reversedCents += payment.amountCents
      property.reversedCents += payment.amountCents
    }
  }

  const rows: EntitySettlement[] = [...entities.values()].map((entity) => {
    const properties = [...entity.properties.values()].map((property) => ({
      ...property,
      netCents: property.settledCents - property.reversedCents,
    }))
    return {
      legalEntityId: entity.legalEntityId,
      settledCents: entity.settledCents,
      reversedCents: entity.reversedCents,
      netCents: entity.settledCents - entity.reversedCents,
      // Biggest share first within the entity, so the house carrying the
      // transfer is the one at the top.
      properties: properties.sort((a, b) => b.netCents - a.netCents),
      paymentIds: entity.paymentIds,
    }
  })

  rows.sort((a, b) => b.netCents - a.netCents)

  return {
    entities: rows,
    settledCents: rows.reduce((total, row) => total + row.settledCents, 0),
    reversedCents: rows.reduce((total, row) => total + row.reversedCents, 0),
    netCents: rows.reduce((total, row) => total + row.netCents, 0),
  }
}
