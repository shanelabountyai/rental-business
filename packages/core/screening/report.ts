// The adverse-action report (R-297, PRD 10 §7.1): one org's screening
// decisions for a quarter, by outcome, by reason and by property, with the
// days from a complete application to its decision. The record an org hands
// counsel or a HUD inquiry, so it counts what was recorded and infers nothing.

import { type BusinessDate, businessDaysBetween } from '../scheduling/local-time.ts'

export type Decision = 'APPROVED' | 'APPROVED_WITH_CONDITIONS' | 'DECLINED'

export interface Quarter {
  label: string
  /// First day of the quarter, inclusive.
  from: BusinessDate
  /// First day of the next quarter, exclusive.
  to: BusinessDate
}

const QUARTER = /^(\d{4})-Q([1-4])$/

/// `2026-Q4` to its bounds. Null for anything else, so a hand-made URL is a
/// "no such quarter", never a crash.
export function parseQuarter(value: string): Quarter | null {
  const match = QUARTER.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const q = Number(match[2])
  const month = (m: number, y: number) => `${y}-${String(m).padStart(2, '0')}-01`
  return {
    label: value,
    from: month(q * 3 - 2, year),
    to: q === 4 ? month(1, year + 1) : month(q * 3 + 1, year),
  }
}

export function quarterOf(date: BusinessDate): string {
  const [year, month] = date.split('-').map(Number) as [number, number]
  return `${year}-Q${Math.ceil(month / 3)}`
}

export interface DecisionRow {
  decision: Decision
  /// Null on a plain approval, which names no reason.
  reasonCode: string | null
  reasonLabel: string | null
  propertyName: string
  /// The household's application completed, in the property's zone.
  completedOn: BusinessDate | null
  /// The decision, in the property's zone.
  decidedOn: BusinessDate
}

export interface DecisionReport {
  total: number
  byOutcome: Record<Decision, number>
  byReason: { code: string; label: string; count: number }[]
  byProperty: { propertyName: string; total: number; byOutcome: Record<Decision, number> }[]
  /// Days from a complete application to the decision. Null when no row
  /// carries both dates.
  medianDaysToDecision: number | null
  maxDaysToDecision: number | null
}

const none = (): Record<Decision, number> => ({ APPROVED: 0, APPROVED_WITH_CONDITIONS: 0, DECLINED: 0 })

export function decisionReport(rows: readonly DecisionRow[]): DecisionReport {
  const byOutcome = none()
  const reasons = new Map<string, { code: string; label: string; count: number }>()
  const properties = new Map<string, { propertyName: string; total: number; byOutcome: Record<Decision, number> }>()
  const days: number[] = []

  for (const row of rows) {
    byOutcome[row.decision] += 1
    if (row.reasonCode) {
      const reason = reasons.get(row.reasonCode) ?? { code: row.reasonCode, label: row.reasonLabel ?? row.reasonCode, count: 0 }
      reason.count += 1
      reasons.set(row.reasonCode, reason)
    }
    const property = properties.get(row.propertyName) ?? { propertyName: row.propertyName, total: 0, byOutcome: none() }
    property.total += 1
    property.byOutcome[row.decision] += 1
    properties.set(row.propertyName, property)
    if (row.completedOn) days.push(businessDaysBetween(row.completedOn, row.decidedOn))
  }

  days.sort((a, b) => a - b)
  const mid = Math.floor(days.length / 2)
  return {
    total: rows.length,
    byOutcome,
    byReason: [...reasons.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    byProperty: [...properties.values()].sort((a, b) => a.propertyName.localeCompare(b.propertyName)),
    medianDaysToDecision: days.length === 0 ? null : days.length % 2 ? days[mid]! : (days[mid - 1]! + days[mid]!) / 2,
    maxDaysToDecision: days.length === 0 ? null : days[days.length - 1]!,
  }
}
