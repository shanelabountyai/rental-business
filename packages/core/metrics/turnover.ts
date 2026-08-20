import { jobCostCents } from '../workorders/verify.ts'

// Turn cost (LEASE-12, RPT-01, R-075) - the turnover panel's own roll-up
// (`getTurnoverForUnit`, R-072), extracted so the per-item costs and the
// reported total can never drift apart. Before this item the sum lived
// inline in the query (`project.workOrders.reduce((sum, wo) => sum +
// jobCostCents(wo), 0)`), duplicating what the per-item `costCents` field
// on the same response already computes one line down.

export interface TurnCostLine {
  actualLaborCents: number | null
  actualMaterialsCents: number | null
  invoiceCents: number | null
}

/// Sum of `jobCostCents()` over every work order on a turn - the books'
/// number (D-42), the same one every other cost this codebase reports to an
/// owner uses.
export function turnCostCents(workOrders: readonly TurnCostLine[]): number {
  return workOrders.reduce((sum, wo) => sum + jobCostCents(wo), 0)
}
