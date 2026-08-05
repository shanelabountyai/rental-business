import { describe, expect, it } from 'vitest'
import {
  type DocumentAccessFacts,
  type TenantScope,
  tenantCanSeeDocument,
} from './index.ts'

// DOC-03 asks for this rule to be "verified by permission tests". These are
// those tests for the rule itself; apps/web/lib/portal/portal.test.ts proves
// the queries and the download route agree with it against a real database.

const ME: TenantScope = {
  tenantId: 'ten_me',
  leaseIds: ['lease_mine'],
  unitIds: ['unit_mine'],
}

function doc(overrides: Partial<DocumentAccessFacts> = {}): DocumentAccessFacts {
  return { tenantId: null, leaseId: null, deletedAt: null, ...overrides }
}

describe('tenantCanSeeDocument', () => {
  it('allows a document naming the tenant', () => {
    expect(tenantCanSeeDocument(doc({ tenantId: 'ten_me' }), ME)).toBe(true)
  })

  it('allows a document on a lease the tenant is party to', () => {
    expect(tenantCanSeeDocument(doc({ leaseId: 'lease_mine' }), ME)).toBe(true)
  })

  it('refuses another tenant’s document', () => {
    expect(tenantCanSeeDocument(doc({ tenantId: 'ten_other' }), ME)).toBe(false)
  })

  it('refuses another tenancy’s document at the same address', () => {
    // The case that matters most at a duplex or after a turnover: the
    // previous tenant's lease is a document at the property this tenant now
    // rents.
    expect(tenantCanSeeDocument(doc({ leaseId: 'lease_theirs' }), ME)).toBe(
      false,
    )
  })

  it('refuses a document with no tenant and no lease', () => {
    // The landlord's own file: the deed, the mortgage note, insurance
    // declarations, HOA papers, warranties (R-015), inspection reports, unit
    // and shutoff photos. All of these carry a propertyId and nothing else,
    // and a property-based rule would hand over every one of them.
    expect(tenantCanSeeDocument(doc(), ME)).toBe(false)
  })

  it('refuses a soft-deleted document even when it is theirs', () => {
    expect(
      tenantCanSeeDocument(
        doc({ tenantId: 'ten_me', deletedAt: new Date() }),
        ME,
      ),
    ).toBe(false)
    expect(
      tenantCanSeeDocument(
        doc({ leaseId: 'lease_mine', deletedAt: new Date() }),
        ME,
      ),
    ).toBe(false)
  })

  it('refuses everything for a tenant with no leases', () => {
    const noLeases: TenantScope = { tenantId: 'ten_new', leaseIds: [] }
    expect(tenantCanSeeDocument(doc({ leaseId: 'lease_mine' }), noLeases)).toBe(
      false,
    )
    // ...but their own named documents still reach them, which is what an
    // applicant with a screening report needs.
    expect(tenantCanSeeDocument(doc({ tenantId: 'ten_new' }), noLeases)).toBe(
      true,
    )
  })

  it('never matches on a null id colliding with a null scope value', () => {
    // A null tenantId must not equal a null anything. Written as an explicit
    // test because `doc.tenantId === scope.tenantId` would be TRUE if a scope
    // were ever built with a null id, and the failure would be silent and
    // total - every landlord document visible to one broken session.
    const broken = { tenantId: null as unknown as string, leaseIds: [] }
    expect(tenantCanSeeDocument(doc(), broken)).toBe(false)
    expect(tenantCanSeeDocument(doc({ tenantId: null }), broken)).toBe(false)
  })
})

// R-020 widened this rule by exactly one clause. These are the tests for that
// clause - both what it now allows and, more importantly, what it still does
// not.
describe('the shutoff-photo safety exception (R-020)', () => {
  it('allows a shutoff photo on a unit the tenant leases', () => {
    // MAINT-01 requires the emergency intake to display "the relevant
    // shutoff photo/location from the unit record". That photo carries
    // neither tenantId nor leaseId, so without this clause it was refused.
    expect(
      tenantCanSeeDocument(
        doc({ type: 'SHUTOFF_PHOTO', unitId: 'unit_mine' }),
        ME,
      ),
    ).toBe(true)
  })

  it('refuses a shutoff photo on a unit the tenant does NOT lease', () => {
    expect(
      tenantCanSeeDocument(
        doc({ type: 'SHUTOFF_PHOTO', unitId: 'unit_theirs' }),
        ME,
      ),
    ).toBe(false)
  })

  it('refuses every OTHER unit-scoped document on their own unit', () => {
    // The exception is one named type, not "unit documents are visible" -
    // the same unit record holds PROP-08's versioned condition photo
    // library, including photos from previous tenancies of this same home.
    for (const type of [
      'UNIT_PHOTO',
      'INSPECTION_REPORT',
      'MAINTENANCE_PHOTO',
      'LEASE',
      'OTHER',
    ]) {
      expect(
        tenantCanSeeDocument(doc({ type, unitId: 'unit_mine' }), ME),
        type,
      ).toBe(false)
    }
  })

  it('refuses a shutoff photo with no unit at all', () => {
    expect(tenantCanSeeDocument(doc({ type: 'SHUTOFF_PHOTO' }), ME)).toBe(false)
  })

  it('refuses a soft-deleted shutoff photo', () => {
    expect(
      tenantCanSeeDocument(
        doc({ type: 'SHUTOFF_PHOTO', unitId: 'unit_mine', deletedAt: new Date() }),
        ME,
      ),
    ).toBe(false)
  })

  it('matches nothing when the scope was built without unitIds', () => {
    // The field is optional so every pre-R-020 caller keeps compiling. An
    // absent list must mean "cannot match", never "matches anything" - this
    // is the safe direction for a field whose only job is to widen access.
    const noUnits: TenantScope = { tenantId: 'ten_me', leaseIds: ['lease_mine'] }
    expect(
      tenantCanSeeDocument(
        doc({ type: 'SHUTOFF_PHOTO', unitId: 'unit_mine' }),
        noUnits,
      ),
    ).toBe(false)
  })
})
