// The year-end income/expense export, per legal entity (RPT-03, R-078).
//
// Pure: every row it needs is handed in. The web layer fetches, this decides.
//
// ===========================================================================
// NOTHING IS SILENTLY DROPPED. That is the one invariant here, and it is the
// reason the return value carries an `exceptions` list and a `counts` block
// rather than just lines. Every fact that goes in comes out somewhere -
// mapped to a Schedule E line, held on the deposit-liability or CapEx
// schedule, or named on the exception list with a reason. A row that
// disappeared quietly is money missing from a return, and the person who
// would notice is an auditor.
// ===========================================================================

import { businessDate, utcToBusinessDate } from '../scheduling/local-time.ts'
import type { BusinessDate } from '../scheduling/local-time.ts'
import {
  SCHEDULE_E,
  type ScheduleEKey,
  ledgerIncomeMapping,
  workOrderExpenseLine,
} from './schedule-e.ts'

/**
 * Cash: a line exists when money moved. Accrual: when the obligation was
 * created. The choice is the filer's and it changes which rows exist at all,
 * not merely how they are labelled - so it is a parameter, never a default
 * buried in a query.
 */
export type AccountingBasis = 'cash' | 'accrual'

export const ACCOUNTING_BASES = ['cash', 'accrual'] as const

export function isAccountingBasis(value: string): value is AccountingBasis {
  return (ACCOUNTING_BASES as readonly string[]).includes(value)
}

/**
 * One income row.
 *
 * `source` is a discriminator with a job: a ledger row's `amountCents` is
 * SIGNED THE LEDGER'S WAY - money received is negative, because the ledger
 * is a balance and a payment reduces what is owed. A charge row is positive.
 * Normalising that here rather than at the query is deliberate: a sign flip
 * applied in the wrong place is invisible in every screenshot and wrong in
 * every total, so it happens once, in a function with a test on it.
 */
export interface IncomeFact {
  source: 'ledger' | 'charge'
  sourceId: string
  propertyId: string
  bookedOn: BusinessDate
  /// Null when no `Charge` backs the row - the ordinary case for
  /// subscription rent. See `ledgerIncomeMapping`.
  chargeType: string | null
  amountCents: number
  description: string
}

export interface WorkOrderFact {
  id: string
  propertyId: string
  scope: string
  vendorName: string | null
  turnoverProjectId: string | null
  actualLaborCents: number | null
  actualMaterialsCents: number | null
  invoiceCents: number | null
  closedAt: Date | null
  invoicePaidAt: Date | null
  /// True when a `CapitalImprovement` names this job. Its cost is on the
  /// CapEx schedule and must NOT also be deducted as a repair.
  capitalised: boolean
}

export interface UtilityBillFact {
  id: string
  propertyId: string
  utilityType: string
  landlordCents: number | null
  periodEnd: Date
}

export interface EvictionCostFact {
  id: string
  propertyId: string
  type: string
  description: string
  amountCents: number
  incurredOn: Date
}

/**
 * One lender's Form 1098 for the year (R-081b).
 *
 * Annual by construction: a 1098 covers a calendar year and names no month,
 * so `bookedOn` is null on the line it produces. That is why it does not
 * appear in the operating report's monthly grid — a figure with no month
 * cannot be put in one without inventing detail nobody recorded.
 */
export interface MortgageInterestFact {
  id: string
  propertyId: string
  lender: string
  interestCents: number
}

export interface CapitalImprovementFact {
  id: string
  propertyId: string
  category: string
  description: string
  costCents: number
  inServiceOn: Date | null
}

export interface TaxExportFacts {
  legalEntityId: string
  legalEntityName: string
  year: number
  propertyNames: ReadonlyMap<string, string>
  /// IANA zone per property, and load-bearing rather than cosmetic. Which
  /// TAX YEAR a job paid at 6pm on 31 December falls into is decided by the
  /// property's own clock, not the server's - and on Vercel the server's is
  /// UTC, so a Texas payment on New Year's Eve would land in the following
  /// year for every property west of it. `Lease.startsOn` was read the wrong
  /// way round at R-042 and gained a day on every move-in; this is the same
  /// hazard pointed at a year boundary, where the cost is a deduction taken
  /// in the wrong return.
  ///
  /// One entity's properties can span zones (D-3), so this is per property
  /// and never one zone for the entity.
  propertyTimezones: ReadonlyMap<string, string>
  income: readonly IncomeFact[]
  workOrders: readonly WorkOrderFact[]
  utilityBills: readonly UtilityBillFact[]
  evictionCosts: readonly EvictionCostFact[]
  capitalImprovements: readonly CapitalImprovementFact[]
  /// The 1098s recorded for this tax year. Already year-scoped by the
  /// caller - `taxYear` is a plain integer column, so there is no window and
  /// no timezone question.
  mortgageInterest: readonly MortgageInterestFact[]
}

export type ExportSection = 'INCOME' | 'EXPENSE' | 'DEPOSIT_LIABILITY' | 'CAPEX' | 'EXCEPTION'

export interface ExportLine {
  section: ExportSection
  bookedOn: BusinessDate | null
  propertyId: string
  propertyName: string
  /// Null on a CapEx or exception row - neither belongs to a Schedule E line.
  scheduleELine: number | null
  scheduleELabel: string
  quickBooksAccount: string
  description: string
  amountCents: number
  sourceKind: string
  sourceId: string
  /// Set only on an exception - why this money could not be mapped, and what
  /// would fix it. Never blank on an exception row.
  reason?: string
}

export interface TaxExport {
  legalEntityId: string
  legalEntityName: string
  year: number
  basis: AccountingBasis
  lines: ExportLine[]
  exceptions: ExportLine[]
  /// Every Schedule E line that has money on it, in form order.
  totalsByLine: { key: ScheduleEKey; line: number; label: string; amountCents: number }[]
  incomeCents: number
  expenseCents: number
  depositLiabilityCents: number
  capexCents: number
  exceptionCents: number
  /// The reconciliation, and it is exhaustive on purpose: every row handed
  /// in leaves by exactly one of these four doors, and a test asserts that
  /// `mapped + excepted + outOfYear + capitalised === facts`. Without the
  /// last two the identity would not hold and the list would be decoration -
  /// a count that does not have to add up cannot catch a dropped row.
  counts: {
    facts: number
    mapped: number
    excepted: number
    /// Fetched, but booked in another tax year under this basis.
    outOfYear: number
    /// A work order whose cost is carried by a CapitalImprovement instead.
    capitalised: number
  }
}

/// The reader for a `@db.Date` column - a calendar day, which no timezone
/// may touch (CLAUDE.md: "if a value is a calendar day, no zone may touch
/// it"). `periodEnd`, `incurredOn` and `inServiceOn` are all this kind.
function calendarDay(value: Date): BusinessDate {
  return utcToBusinessDate(value)
}

export function buildTaxExport(facts: TaxExportFacts, basis: AccountingBasis): TaxExport {
  const lines: ExportLine[] = []
  const exceptions: ExportLine[] = []
  let outOfYear = 0
  let capitalised = 0
  const name = (propertyId: string) => facts.propertyNames.get(propertyId) ?? propertyId

  /// The reader for a real timestamp - `closedAt`, `invoicePaidAt`. Goes
  /// through the PROPERTY's zone, never the server's. See
  /// `propertyTimezones`.
  const instantDay = (instant: Date, propertyId: string): BusinessDate =>
    businessDate(instant, facts.propertyTimezones.get(propertyId) ?? 'UTC')

  const inYear = (day: BusinessDate) => Number(day.slice(0, 4)) === facts.year

  function mapped(
    section: ExportSection,
    key: ScheduleEKey,
    fields: Omit<
      ExportLine,
      'section' | 'scheduleELine' | 'scheduleELabel' | 'quickBooksAccount' | 'propertyName'
    >,
  ) {
    lines.push({
      section,
      scheduleELine: SCHEDULE_E[key].line,
      scheduleELabel: SCHEDULE_E[key].label,
      quickBooksAccount: SCHEDULE_E[key].quickBooksAccount,
      propertyName: name(fields.propertyId),
      ...fields,
    })
  }

  function except(
    fields: Omit<
      ExportLine,
      'section' | 'scheduleELine' | 'scheduleELabel' | 'quickBooksAccount' | 'propertyName'
    > & { reason: string },
  ) {
    exceptions.push({
      section: 'EXCEPTION',
      scheduleELine: null,
      scheduleELabel: 'Unmapped',
      quickBooksAccount: '',
      propertyName: name(fields.propertyId),
      ...fields,
    })
  }

  // -- Income ---------------------------------------------------------------
  //
  // The caller picked the source table from the basis (ledger for cash,
  // charges for accrual) because they are genuinely different tables; the
  // sign normalisation and the mapping are here.
  for (const row of facts.income) {
    // The caller fetches a generous window and every year decision is made
    // here, so there is exactly one place that knows what "in 2026" means.
    if (!inYear(row.bookedOn)) {
      outOfYear += 1
      continue
    }
    const amountCents = row.source === 'ledger' ? -row.amountCents : row.amountCents
    const mapping = ledgerIncomeMapping(row.chargeType)
    const common = {
      bookedOn: row.bookedOn,
      propertyId: row.propertyId,
      description: row.description,
      amountCents,
      sourceKind: row.source === 'ledger' ? 'LedgerEntry' : 'Charge',
      sourceId: row.sourceId,
    }

    if (mapping === 'UNMAPPED') {
      except({
        ...common,
        reason: `Charge type "${row.chargeType ?? 'unknown'}" carries no Schedule E mapping. Re-type the charge, or ask your preparer where it belongs.`,
      })
      continue
    }
    if (mapping === 'DEPOSIT_LIABILITY') {
      lines.push({
        section: 'DEPOSIT_LIABILITY',
        scheduleELine: null,
        scheduleELabel: 'Security deposit held (not income)',
        quickBooksAccount: 'Security Deposits Held',
        propertyName: name(row.propertyId),
        ...common,
      })
      continue
    }
    mapped('INCOME', mapping, common)
  }

  // -- Maintenance ----------------------------------------------------------
  for (const job of facts.workOrders) {
    // Capitalised: the money is on the CapEx schedule below. Deducting it
    // here as well would claim the same dollars twice, in two different ways.
    if (job.capitalised) {
      capitalised += 1
      continue
    }

    const bookedAt = basis === 'cash' ? job.invoicePaidAt : job.closedAt
    const bookedOn = bookedAt == null ? null : instantDay(bookedAt, job.propertyId)
    if (bookedOn == null || !inYear(bookedOn)) {
      outOfYear += 1
      continue
    }

    // D-42: the BOOKS' number takes the invoice where there is one.
    // `actualTotalCents()` - the approval-ceiling number - would overstate a
    // return whenever recorded parts beat the bill.
    const costCents =
      job.invoiceCents ?? (job.actualLaborCents ?? 0) + (job.actualMaterialsCents ?? 0)
    const common = {
      bookedOn,
      propertyId: job.propertyId,
      description: job.vendorName ? `${job.scope} — ${job.vendorName}` : job.scope,
      amountCents: costCents,
      sourceKind: 'WorkOrder',
      sourceId: job.id,
    }

    if (costCents === 0) {
      except({
        ...common,
        reason:
          basis === 'cash'
            ? 'Marked paid with no invoice or actuals recorded, so there is no amount to deduct.'
            : 'Closed with no invoice or actuals recorded, so there is no amount to deduct.',
      })
      continue
    }
    mapped('EXPENSE', workOrderExpenseLine(job), common)
  }

  // -- Utilities the owner absorbed -----------------------------------------
  // The caller fetches only bills where the owner actually absorbed a share;
  // a zero here would export as a visible $0 line rather than vanish, which
  // is the direction this whole file leans.
  for (const bill of facts.utilityBills) {
    const amountCents = bill.landlordCents ?? 0
    const common = {
      bookedOn: calendarDay(bill.periodEnd),
      propertyId: bill.propertyId,
      description: `${bill.utilityType} — owner's share`,
      amountCents,
      sourceKind: 'UtilityBill',
      sourceId: bill.id,
    }

    // A utility bill records the PERIOD it covers and never when it was
    // paid, so on a cash basis there is no date to book it on. Booking it on
    // period end instead would be a guess, and the guess is wrong precisely
    // at the year boundary - a December bill paid in January - which is the
    // one place the two bases actually differ.
    if (basis === 'cash') {
      except({
        ...common,
        reason:
          'No payment date is recorded on a utility bill, so it cannot be booked on a cash basis. Export on an accrual basis, or enter it with your preparer.',
      })
      continue
    }
    if (!inYear(calendarDay(bill.periodEnd))) {
      outOfYear += 1
      continue
    }
    mapped('EXPENSE', 'UTILITIES', common)
  }

  // -- Eviction costs -------------------------------------------------------
  //
  // `incurredOn` is the only date these carry, and an owner-side outlay is
  // recorded when it is paid out - filing fees, service, attorney invoices.
  // The same date serves both bases, which is why there is no branch here.
  for (const cost of facts.evictionCosts) {
    if (!inYear(calendarDay(cost.incurredOn))) {
      outOfYear += 1
      continue
    }
    mapped('EXPENSE', 'LEGAL_PROFESSIONAL', {
      bookedOn: calendarDay(cost.incurredOn),
      propertyId: cost.propertyId,
      description: `${cost.type} — ${cost.description}`,
      amountCents: cost.amountCents,
      sourceKind: 'EvictionCost',
      sourceId: cost.id,
    })
  }

  // -- Mortgage interest, from the lender's 1098 ----------------------------
  //
  // The same figure on either basis: a 1098 reports the interest RECEIVED by
  // the lender in the calendar year, which is cash-basis by construction, and
  // there is no accrual figure to prefer over it.
  for (const statement of facts.mortgageInterest) {
    mapped('EXPENSE', 'MORTGAGE_INTEREST', {
      // No month. See `MortgageInterestFact`.
      bookedOn: null,
      propertyId: statement.propertyId,
      description: `${statement.lender} — interest per Form 1098`,
      amountCents: statement.interestCents,
      sourceKind: 'MortgageAnnualStatement',
      sourceId: statement.id,
    })
  }

  // -- Capital improvements -------------------------------------------------
  //
  // Not a Schedule E expense line: capitalised, and depreciated from the day
  // it was placed in service. This section is the schedule a preparer needs
  // to compute line 18; this product deliberately does not compute it.
  for (const capex of facts.capitalImprovements) {
    const common = {
      propertyId: capex.propertyId,
      description: `${capex.category} — ${capex.description}`,
      amountCents: capex.costCents,
      sourceKind: 'CapitalImprovement',
      sourceId: capex.id,
    }

    if (capex.inServiceOn == null) {
      except({
        ...common,
        bookedOn: null,
        reason:
          'No in-service date, so it cannot be placed on a depreciation schedule. Add the date the improvement was first available for use.',
      })
      continue
    }
    if (!inYear(calendarDay(capex.inServiceOn))) {
      outOfYear += 1
      continue
    }
    lines.push({
      section: 'CAPEX',
      scheduleELine: null,
      scheduleELabel: 'Capital improvement (depreciable)',
      quickBooksAccount: 'Buildings and Improvements',
      propertyName: name(capex.propertyId),
      bookedOn: calendarDay(capex.inServiceOn),
      ...common,
    })
  }

  const sum = (rows: readonly ExportLine[]) => rows.reduce((total, row) => total + row.amountCents, 0)
  const inSection = (section: ExportSection) => lines.filter((row) => row.section === section)

  const byLine = new Map<ScheduleEKey, number>()
  for (const row of lines) {
    if (row.scheduleELine == null) continue
    const key = (Object.keys(SCHEDULE_E) as ScheduleEKey[]).find(
      (candidate) => SCHEDULE_E[candidate].line === row.scheduleELine,
    )
    if (key) byLine.set(key, (byLine.get(key) ?? 0) + row.amountCents)
  }

  return {
    legalEntityId: facts.legalEntityId,
    legalEntityName: facts.legalEntityName,
    year: facts.year,
    basis,
    lines,
    exceptions,
    totalsByLine: [...byLine.entries()]
      .map(([key, amountCents]) => ({
        key,
        line: SCHEDULE_E[key].line,
        label: SCHEDULE_E[key].label,
        amountCents,
      }))
      .sort((a, b) => a.line - b.line),
    incomeCents: sum(inSection('INCOME')),
    expenseCents: sum(inSection('EXPENSE')),
    depositLiabilityCents: sum(inSection('DEPOSIT_LIABILITY')),
    capexCents: sum(inSection('CAPEX')),
    exceptionCents: sum(exceptions),
    counts: {
      facts:
        facts.income.length +
        facts.workOrders.length +
        facts.utilityBills.length +
        facts.evictionCosts.length +
        facts.capitalImprovements.length +
        facts.mortgageInterest.length,
      mapped: lines.length,
      excepted: exceptions.length,
      outOfYear,
      capitalised,
    },
  }
}

export const TAX_EXPORT_CSV_HEADERS = [
  'Section',
  'Date',
  'Property',
  'Schedule E line',
  'Schedule E label',
  'QuickBooks account',
  'Description',
  'Amount',
  'Source',
  'Source ID',
  'Exception reason',
] as const
