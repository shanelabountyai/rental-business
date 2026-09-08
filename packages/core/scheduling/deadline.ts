// R-182 (review finding 14): the one function every statutory clock in this
// product calls, and the only place that knows HOW a legislature counts to
// thirty.
//
// THE DEFECT THIS REPLACES. `addBusinessDays` adds plain calendar days and
// returns whatever date lands, weekend or public holiday - its name has been
// wrong since R-042 and nine clocks were built on it. That was harmless
// while Texas, which counts statutory periods in calendar days, was the only
// configured state. R-162 was built specifically so a second state can be
// added from a form without a seed script, and several states count notice
// periods in BUSINESS days while several others roll a deadline landing on a
// Saturday or a legal holiday forward to the next business day. D-4 is
// categorical that a number a legislature can change is configuration; how
// that legislature counts is the same kind of fact, and until now there was
// nowhere to put it.
//
// `addBusinessDays` deliberately survives and is deliberately NOT renamed.
// It is still the right primitive for a report's date range, a turn-stage
// target and a showing calendar - none of which is a statutory deadline, and
// none of which any legislature has an opinion about. What must not happen
// again is a STATUTORY deadline reaching it directly, which is why this
// module takes the rule rather than a bare basis: a caller that has no rule
// in hand is a caller computing a legal date it cannot justify.

import { addBusinessDays, type BusinessDate } from './local-time.ts'

/// Mirrors the Prisma `DayCountBasis` enum. A type-only import of the
/// generated enum would drag the Prisma client into any client component
/// that touches this, which is the trap validate.ts's own header documents,
/// so the values are restated and pinned by a `satisfies` there instead.
export type DayCountBasisValue = 'CALENDAR' | 'CALENDAR_ROLL_FORWARD' | 'BUSINESS'

/// Everything this needs off a `JurisdictionRule` row. A structural subset so
/// core stays DB-free and a test can pass a literal.
export interface DayCountRule {
  /// Null means NOBODY HAS REVIEWED THIS STATE's counting rule - the same
  /// three-valued posture `sourceOfIncomeProtected` and `acceptanceWaivesNotice`
  /// already take, and for the same reason: "counsel confirmed Texas counts
  /// calendar days" and "nobody asked" are different claims. Unlike those
  /// booleans this one cannot refuse - every clock here has to produce a
  /// date, and a product that stopped computing deposit deadlines the moment
  /// this column shipped would be a worse product. So null COUNTS AS
  /// CALENDAR, which is exactly today's behaviour and therefore changes no
  /// existing deadline, and the unreviewedness is surfaced by
  /// `computeCoverage` where somebody can act on it.
  dayCountBasis: DayCountBasisValue | null
  /// Days this jurisdiction does not count, as `YYYY-MM-DD`. Lives on the
  /// rule row rather than in a table of its own so that `rulesFor` - the one
  /// place anything reads a statutory number (D-4) - already delivers it, and
  /// so that a holiday list is versioned and effective-dated by exactly the
  /// machinery that versions the numbers beside it. The cost is honest: next
  /// year's dates mean a new rule version, which is how D-4 says config
  /// changes anyway. Empty is the right value for a CALENDAR state, which
  /// never consults it.
  observedHolidays: readonly string[]
}

/**
 * What a caller with NO rule row at all passes.
 *
 * A state with no `JurisdictionRule` has no day count either, and the callers
 * in that position (`cureClockFor`, `cureFor`) are already reporting a clock
 * with no deadline - they need a value to pass, not a decision. Named for
 * what it is so that reaching for it as a default is visibly the wrong move:
 * anything that actually computes a date and lands here is computing it
 * against an unreviewed rule, which is what `computeCoverage` reports on.
 */
export const UNREVIEWED_DAY_COUNT: DayCountRule = {
  dayCountBasis: null,
  observedHolidays: [],
}

/**
 * Saturday and Sunday, plus whatever this jurisdiction observes.
 *
 * The weekend is hardcoded and that is a real limitation with a real
 * boundary: no US state counts a Sunday-Thursday week, and a jurisdiction
 * that did would need a weekday mask here rather than a longer holiday list.
 */
export function isBusinessDay(date: BusinessDate, rule: DayCountRule): boolean {
  // `Date.UTC` on the parsed parts, never `new Date(string)`: a calendar day
  // must not be converted through a timezone (D-3), and `getUTCDay` on a
  // UTC-midnight instant is pure calendar arithmetic.
  const [y, m, d] = date.split('-').map(Number)
  const weekday = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  return !rule.observedHolidays.includes(date)
}

/**
 * The deadline `days` statutory days after `from`, counted the way this
 * jurisdiction counts.
 *
 * - `CALENDAR` — every day counts and the deadline lands where it lands.
 *   Texas, and today's behaviour for every state.
 * - `CALENDAR_ROLL_FORWARD` — every day counts, but a deadline landing on a
 *   weekend or an observed holiday moves to the next business day.
 * - `BUSINESS` — only business days are counted at all. A roll-forward flag
 *   is meaningless here and is not representable, which is why this is one
 *   three-valued column rather than the enum-plus-boolean pair the backlog
 *   row sketched: counting N business days forward lands on a business day
 *   by construction, so the pair has a combination that cannot mean anything
 *   and a form that can therefore be filled in wrongly.
 *
 * ROLLS FORWARD ONLY, NEVER BACK. Every clock here is a period a party is
 * GIVEN - to cure, to store belongings, to return a deposit - and shortening
 * one by rolling backwards takes away time a statute granted. Where the
 * statutory direction is the other way (a deadline to act BEFORE a date) the
 * caller passes a negative `days`, and rolling that result forward would be
 * wrong; this refuses rather than guess, because no such caller exists yet
 * and inventing a rule for one would be inventing law.
 */
export function statutoryDeadline(
  from: BusinessDate,
  days: number,
  rule: DayCountRule,
): BusinessDate {
  const basis = rule.dayCountBasis ?? 'CALENDAR'

  if (days < 0 && basis !== 'CALENDAR') {
    throw new RangeError(
      `statutoryDeadline cannot count ${days} days backwards on a ${basis} basis - no statute in this product runs backwards, and rolling a backwards deadline forward would extend it.`,
    )
  }

  let deadline = from
  if (basis === 'BUSINESS') {
    for (let counted = 0; counted < days; counted++) {
      do {
        deadline = addBusinessDays(deadline, 1)
      } while (!isBusinessDay(deadline, rule))
    }
  } else {
    deadline = addBusinessDays(from, days)
    if (basis === 'CALENDAR') return deadline
  }

  // ROLLED AFTER THE COUNT, ON BOTH NON-CALENDAR BASES, and the case that
  // forces it is a ZERO-DAY period starting on a Saturday. Counting zero
  // business days from a Saturday lands on the Saturday, and the count loop
  // never runs to fix it - so without this, the two bases disagreed about
  // the same day, one rolling to Tuesday and the other not. A zero-day
  // period is real configuration (`earlyTermination`'s own note: a state
  // where the tenancy ends the day notice is delivered), so the branch is
  // reachable, and the direction follows the rule above: rolling forward
  // gives the party MORE of the period, never less.
  while (!isBusinessDay(deadline, rule)) deadline = addBusinessDays(deadline, 1)
  return deadline
}

/// What a state's counting rule means for a deadline in one sentence, for the
/// screen that shows a computed date. Null basis says nothing at all rather
/// than "calendar days": the whole point of the third state is not to assert
/// a review that never happened.
export function dayCountNote(rule: DayCountRule): string | null {
  switch (rule.dayCountBasis) {
    case 'CALENDAR':
      return 'Counted in calendar days.'
    case 'CALENDAR_ROLL_FORWARD':
      return 'Counted in calendar days, moved to the next business day if it lands on a weekend or an observed holiday.'
    case 'BUSINESS':
      return 'Counted in business days — weekends and observed holidays are not counted.'
    default:
      return null
  }
}
