import { describe, expect, it } from 'vitest'
import { currentStageFor } from './queries.ts'

// currentStageFor() (R-076): which turnover stage is currently open, read
// from the project's own work orders rather than a status column the
// schema deliberately does not have (TurnoverProject's own comment).

describe('currentStageFor', () => {
  it('returns the earliest-in-sequence stage still open', () => {
    const stage = currentStageFor([
      { turnoverStage: 'TRASH_OUT', status: 'CLOSED' },
      { turnoverStage: 'REPAIRS', status: 'IN_PROGRESS' },
      { turnoverStage: 'CLEAN', status: 'SUBMITTED' },
    ])
    expect(stage).toBe('REPAIRS')
  })

  it('returns null once every work order is done', () => {
    const stage = currentStageFor([
      { turnoverStage: 'TRASH_OUT', status: 'CLOSED' },
      { turnoverStage: 'REPAIRS', status: 'CANCELED' },
    ])
    expect(stage).toBeNull()
  })

  it('returns null for a project with no work orders yet', () => {
    expect(currentStageFor([])).toBeNull()
  })

  it('ignores a work order with no turnover stage set', () => {
    const stage = currentStageFor([{ turnoverStage: null, status: 'IN_PROGRESS' }])
    expect(stage).toBeNull()
  })
})
