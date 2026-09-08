import { describe, expect, it } from 'vitest'
import {
  planTurn,
  stageWorkIsOpen,
  TURN_SEQUENCE,
  TURN_STAGE_DAYS,
  type TurnPlanInput,
} from './schedule.ts'

// The sequenced turn (R-178, review §10). Pure - no database, no clock.

const MOVE_OUT = '2026-06-30'

function plan(overrides: Partial<TurnPlanInput> = {}) {
  return planTurn({
    moveOutDate: MOVE_OUT,
    targetRentReadyDate: null,
    today: MOVE_OUT,
    workOrders: [],
    ...overrides,
  })
}

/// One open template line per stage - what `startTurnoverProjectForLease`
/// leaves behind the moment a turn opens.
const FRESH_TEMPLATE = TURN_SEQUENCE.map((stage) => ({
  turnoverStage: stage,
  status: 'SUBMITTED',
}))

function withStagesDone(done: readonly string[]) {
  return FRESH_TEMPLATE.map((item) =>
    done.includes(item.turnoverStage) ? { ...item, status: 'WORK_COMPLETE' } : item,
  )
}

function stageOf(result: ReturnType<typeof plan>, stage: string) {
  return result.stages.find((s) => s.stage === stage)!
}

describe('planTurn', () => {
  it('lays the stages forward from the day after move-out, one after another', () => {
    const result = plan()

    expect(stageOf(result, 'TRASH_OUT').startsOn).toBe('2026-07-01')
    expect(stageOf(result, 'TRASH_OUT').dueOn).toBe('2026-07-01')
    // Repairs gets five days, starting the day after trash-out is due.
    expect(stageOf(result, 'REPAIRS').startsOn).toBe('2026-07-02')
    expect(stageOf(result, 'REPAIRS').dueOn).toBe('2026-07-06')
    expect(stageOf(result, 'PAINT').startsOn).toBe('2026-07-07')
  })

  it('projects rent-ready at the sum of the stage budgets', () => {
    const total = Object.values(TURN_STAGE_DAYS).reduce((sum, days) => sum + days, 0)
    expect(total).toBe(13)
    // Move-out 30 June, thirteen days of work starting 1 July.
    expect(plan().projectedRentReadyOn).toBe('2026-07-13')
  })

  it('reports how far the standard turn overruns a committed target, and nothing when it fits', () => {
    expect(plan({ targetRentReadyDate: '2026-07-08' }).daysOverTarget).toBe(5)
    expect(plan({ targetRentReadyDate: '2026-07-13' }).daysOverTarget).toBeNull()
    expect(plan({ targetRentReadyDate: '2026-08-01' }).daysOverTarget).toBeNull()
    expect(plan({ targetRentReadyDate: null }).daysOverTarget).toBeNull()
  })

  it('names the earliest earlier stage still holding open work - the point of the item', () => {
    // Trash-out and repairs done, paint still open: the floor guy is waiting
    // on paint and nothing further back.
    const result = plan({ workOrders: withStagesDone(['TRASH_OUT', 'REPAIRS']) })

    expect(stageOf(result, 'PAINT').waitingOn).toBeNull()
    expect(stageOf(result, 'FLOORS').waitingOn).toBe('PAINT')
    expect(stageOf(result, 'CLEAN').waitingOn).toBe('PAINT')
  })

  it('never blocks the re-key, which R-176 opens as urgent on day one', () => {
    // Everything ahead of it outstanding - and re-key still waits on nothing,
    // because the panel must not contradict the URGENT work order beside it.
    expect(stageOf(plan({ workOrders: FRESH_TEMPLATE }), 'REKEY').waitingOn).toBeNull()
  })

  it('treats a canceled stage as nothing left to wait for', () => {
    // The unit does not need floors. Canceling that line must unblock clean,
    // which is the whole reason a template you can cancel from is usable.
    const workOrders = FRESH_TEMPLATE.map((item) =>
      item.turnoverStage === 'FLOORS'
        ? { ...item, status: 'CANCELED' }
        : item.turnoverStage === 'CLEAN'
          ? item
          : { ...item, status: 'CLOSED' },
    )
    const result = plan({ workOrders })

    expect(stageOf(result, 'FLOORS').state).toBe('DONE')
    expect(stageOf(result, 'CLEAN').waitingOn).toBeNull()
  })

  it('separates a stage nobody has touched from one somebody is working', () => {
    const result = plan({
      workOrders: [
        { turnoverStage: 'TRASH_OUT', status: 'IN_PROGRESS' },
        { turnoverStage: 'REPAIRS', status: 'SUBMITTED' },
      ],
    })

    expect(stageOf(result, 'TRASH_OUT').state).toBe('IN_PROGRESS')
    expect(stageOf(result, 'REPAIRS').state).toBe('NOT_STARTED')
    expect(stageOf(result, 'PAINT').state).toBe('EMPTY')
  })

  it('goes overdue only for a stage with work still open', () => {
    const workOrders = withStagesDone(['TRASH_OUT'])
    const result = plan({ workOrders, today: '2026-07-10' })

    // Trash-out was due 1 July and is finished.
    expect(stageOf(result, 'TRASH_OUT').overdue).toBe(false)
    // Repairs was due 6 July and is not.
    expect(stageOf(result, 'REPAIRS').overdue).toBe(true)
    // Clean is not due until 12 July.
    expect(stageOf(result, 'CLEAN').overdue).toBe(false)
  })

  it('does not go overdue on the due date itself', () => {
    const result = plan({ workOrders: FRESH_TEMPLATE, today: '2026-07-01' })
    expect(stageOf(result, 'TRASH_OUT').overdue).toBe(false)
    expect(plan({ workOrders: FRESH_TEMPLATE, today: '2026-07-02' }).stages[0]!.overdue).toBe(true)
  })

  it('ignores unstaged and OTHER work orders entirely', () => {
    // `draftPunchListFromInspection` creates its findings unstaged on
    // purpose, and OTHER has no position in the sequence.
    const result = plan({
      workOrders: [
        { turnoverStage: null, status: 'SUBMITTED' },
        { turnoverStage: 'OTHER', status: 'SUBMITTED' },
      ],
    })
    expect(result.stages.every((s) => s.state === 'EMPTY')).toBe(true)
  })
})

describe('stageWorkIsOpen', () => {
  it('reads the physical work, not the invoice - a floor guy starts when the paint is done', () => {
    // The distinction from OPEN_WORK_ORDER_STATUSES, which counts both of
    // these as open because the vendor is still owed money.
    expect(stageWorkIsOpen('WORK_COMPLETE')).toBe(false)
    expect(stageWorkIsOpen('VERIFIED')).toBe(false)
    expect(stageWorkIsOpen('IN_PROGRESS')).toBe(true)
    expect(stageWorkIsOpen('WAITING_ON_TENANT')).toBe(true)
    expect(stageWorkIsOpen('CANCELED')).toBe(false)
  })
})
