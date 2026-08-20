import { describe, expect, it } from 'vitest'
import { jobCostCents } from '../workorders/verify.ts'
import { turnCostCents } from './turnover.ts'

describe('turnCostCents', () => {
  it('sums jobCostCents across every work order on the turn', () => {
    const workOrders = [
      { actualLaborCents: 10_000, actualMaterialsCents: 2_000, invoiceCents: null }, // 12,000
      { actualLaborCents: null, actualMaterialsCents: null, invoiceCents: 30_000 }, // 30,000 (invoice wins)
      { actualLaborCents: 5_000, actualMaterialsCents: 0, invoiceCents: null }, // 5,000
    ]
    expect(turnCostCents(workOrders)).toBe(47_000)
  })

  it('is 0 for a turn with no work orders yet', () => {
    expect(turnCostCents([])).toBe(0)
  })

  // The roll-up-equals-sum check R-075's own backlog text calls out: the
  // turnover panel shows a per-item cost list (`items[].costCents`, each
  // `jobCostCents(wo)`) ALONGSIDE a total (`turnCostCents(workOrders)`) - if
  // those two ever disagreed, an owner adding up the list by hand would get
  // a different number than the header. They cannot, because both are built
  // from the identical `jobCostCents()` call, one per item and one summed.
  it('the reported total always equals the sum of its own itemized lines', () => {
    const workOrders = [
      { actualLaborCents: 8_000, actualMaterialsCents: 1_500, invoiceCents: null },
      { actualLaborCents: null, actualMaterialsCents: null, invoiceCents: 22_500 },
      { actualLaborCents: 0, actualMaterialsCents: 0, invoiceCents: 0 },
    ]
    const items = workOrders.map((wo) => jobCostCents(wo))
    const itemizedSum = items.reduce((sum, cents) => sum + cents, 0)
    expect(turnCostCents(workOrders)).toBe(itemizedSum)
  })
})
