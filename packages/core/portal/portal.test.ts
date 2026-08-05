import { describe, expect, it } from 'vitest'
import {
  type DocumentAccessFacts,
  type TenantScope,
  tenantCanSeeDocument,
} from './index.ts'

// DOC-03 asks for this rule to be "verified by permission tests". These are
// those tests for the rule itself; apps/web/lib/portal/portal.test.ts proves
// the queries and the download route agree with it against a real database.

const ME: TenantScope = { tenantId: 'ten_me', leaseIds: ['lease_mine'] }

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
