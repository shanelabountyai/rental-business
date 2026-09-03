import { describe, expect, it } from 'vitest'
import { inspectionRequiresEntryNotice } from './entry.ts'

describe('inspectionRequiresEntryNotice', () => {
  it('requires notice for interior walks of an occupied unit', () => {
    expect(inspectionRequiresEntryNotice('PERIODIC', 'ACTIVE')).toBe(true)
    expect(inspectionRequiresEntryNotice('PRE_MOVE_OUT', 'ACTIVE')).toBe(true)
    expect(inspectionRequiresEntryNotice('MOVE_OUT', 'MONTH_TO_MONTH')).toBe(true)
  })

  it('never requires notice for exterior walks', () => {
    expect(inspectionRequiresEntryNotice('SEASONAL', 'ACTIVE')).toBe(false)
    expect(inspectionRequiresEntryNotice('DRIVE_BY', 'ACTIVE')).toBe(false)
  })

  it('never requires notice for a move-in walk - the tenant is not yet in residence', () => {
    expect(inspectionRequiresEntryNotice('MOVE_IN', 'ACTIVE')).toBe(false)
  })

  it('requires nothing once the tenancy is over, or when there never was one', () => {
    expect(inspectionRequiresEntryNotice('MOVE_OUT', 'ENDED')).toBe(false)
    expect(inspectionRequiresEntryNotice('MOVE_OUT', 'TERMINATED')).toBe(false)
    expect(inspectionRequiresEntryNotice('PERIODIC', null)).toBe(false)
    expect(inspectionRequiresEntryNotice('PERIODIC', 'DRAFT')).toBe(false)
  })
})
