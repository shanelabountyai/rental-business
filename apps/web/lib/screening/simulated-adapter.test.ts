import { describe, expect, it } from 'vitest'
import { SimulatedScreeningAdapter, simulatedScreeningFacts } from './simulated-adapter.ts'

// The simulated screening provider (D-7, R-060). No database - this is the
// adapter's own contract, exercised the way listings/simulated-adapter.test.ts
// exercises its sibling.

describe('SimulatedScreeningAdapter', () => {
  it('says what it is', () => {
    expect(new SimulatedScreeningAdapter().name).toBe('simulated')
  })

  it('mints a realistic-shaped provider id, different each call', async () => {
    const adapter = new SimulatedScreeningAdapter()
    const first = await adapter.order({ applicantId: 'app_1' })
    const second = await adapter.order({ applicantId: 'app_1' })
    expect(first.providerId).toMatch(/^scr_[a-f0-9]{24}$/)
    expect(first.providerId).not.toBe(second.providerId)
  })

  it('returns report facts DETERMINISTIC from the applicant id - same id, same facts, every time', async () => {
    const adapter = new SimulatedScreeningAdapter()
    const first = await adapter.order({ applicantId: 'app_stable' })
    const second = await adapter.order({ applicantId: 'app_stable' })
    expect(first.status).toBe('COMPLETE')
    expect(first.creditScore).toBe(second.creditScore)
    expect(first.evictionRecordFound).toBe(second.evictionRecordFound)
    expect(first.criminalRecordFound).toBe(second.criminalRecordFound)
  })

  it('matches the exported simulatedScreeningFacts() helper', async () => {
    const adapter = new SimulatedScreeningAdapter()
    const result = await adapter.order({ applicantId: 'app_predict' })
    expect(result).toMatchObject(simulatedScreeningFacts('app_predict'))
  })

  it('a different applicant id gets different facts', async () => {
    const adapter = new SimulatedScreeningAdapter()
    const a = await adapter.order({ applicantId: 'app_a' })
    const b = await adapter.order({ applicantId: 'app_b' })
    expect(a.creditScore).not.toBe(b.creditScore)
  })

  it('a credit score always lands in a realistic FICO-shaped range', async () => {
    const adapter = new SimulatedScreeningAdapter()
    for (const id of ['x1', 'x2', 'x3', 'x4', 'x5']) {
      const result = await adapter.order({ applicantId: id })
      expect(result.creditScore).toBeGreaterThanOrEqual(500)
      expect(result.creditScore).toBeLessThanOrEqual(849)
    }
  })

  it('faults with the injected code and no report facts', async () => {
    const adapter = new SimulatedScreeningAdapter({ fault: () => 'timeout' })
    const result = await adapter.order({ applicantId: 'app_1' })
    expect(result.status).toBe('FAILED')
    expect(result.faultCode).toBe('timeout')
    expect(result.creditScore).toBeUndefined()
  })
})
