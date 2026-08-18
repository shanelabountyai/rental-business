import { validateDocumentTemplate } from '@rental/core/documents'
import { ADDENDUM_KEYS, unknownLeaseMergeFields } from '@rental/core/leases'
import { describe, expect, it } from 'vitest'
import { ADDENDUM_BODIES, LEASE_BODY } from './seed-lease-templates.mts'

// Importing this module must never touch a database - see the file's own
// `pathToFileURL` guard. If that guard regresses, this test hangs or throws
// on a missing DATABASE_URL rather than failing cleanly, which is itself a
// useful signal.

describe('seed-lease-templates bodies', () => {
  it('the base lease references only catalogued merge fields', () => {
    expect(unknownLeaseMergeFields(LEASE_BODY)).toEqual([])
  })

  it('every addendum exists for every closed key and references only catalogued fields', () => {
    for (const key of ADDENDUM_KEYS) {
      expect(ADDENDUM_BODIES[key]).toBeTruthy()
      expect(unknownLeaseMergeFields(ADDENDUM_BODIES[key])).toEqual([])
    }
  })

  it('passes the generic template validator (name/body shape only, not the lease catalogue)', () => {
    const leaseViolations = validateDocumentTemplate({
      name: 'Residential lease',
      documentType: 'LEASE',
      body: LEASE_BODY,
    })
    // Only the merge-field check is skipped by validateDocumentTemplate for
    // LEASE/ADDENDUM (see that function's own comment) - name/type/body
    // presence still applies and should hold here.
    expect(leaseViolations).toEqual([])

    for (const key of ADDENDUM_KEYS) {
      const violations = validateDocumentTemplate({
        name: `${key} addendum`,
        documentType: 'ADDENDUM',
        addendumKey: key,
        body: ADDENDUM_BODIES[key],
      })
      expect(violations).toEqual([])
    }
  })
})
