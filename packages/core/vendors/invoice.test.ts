import { describe, expect, it } from 'vitest'
import { invoiceLifecycleStatus, requiresForm1099 } from './invoice.ts'

describe('invoiceLifecycleStatus', () => {
  it('is not_received with no invoice on file', () => {
    expect(invoiceLifecycleStatus({ invoiceCents: null, overTolerance: false, invoicePaidAt: null })).toBe(
      'not_received',
    )
  })

  it('auto-routes an in-tolerance invoice straight to approved', () => {
    expect(
      invoiceLifecycleStatus({ invoiceCents: 50_000, overTolerance: false, invoicePaidAt: null }),
    ).toBe('approved')
  })

  it('stops an over-tolerance invoice for review', () => {
    expect(
      invoiceLifecycleStatus({ invoiceCents: 50_000, overTolerance: true, invoicePaidAt: null }),
    ).toBe('needs_approval')
  })

  it('is paid once paid, regardless of tolerance', () => {
    expect(
      invoiceLifecycleStatus({ invoiceCents: 50_000, overTolerance: true, invoicePaidAt: new Date() }),
    ).toBe('paid')
  })
})

describe('requiresForm1099', () => {
  it('flags at the $600 threshold and above', () => {
    expect(requiresForm1099(60_000)).toBe(true)
    expect(requiresForm1099(59_999)).toBe(false)
  })
})
