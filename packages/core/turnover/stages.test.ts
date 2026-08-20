import { describe, expect, it } from 'vitest'
import { TURNOVER_STAGES, TURNOVER_STAGE_LABELS, isTurnoverStage } from './stages.ts'

describe('isTurnoverStage', () => {
  it('accepts every declared stage', () => {
    for (const stage of TURNOVER_STAGES) {
      expect(isTurnoverStage(stage)).toBe(true)
    }
  })

  it('rejects an unknown value', () => {
    expect(isTurnoverStage('DEMOLITION')).toBe(false)
  })

  it('has a label for every stage', () => {
    for (const stage of TURNOVER_STAGES) {
      expect(TURNOVER_STAGE_LABELS[stage]).toBeTruthy()
    }
  })
})
