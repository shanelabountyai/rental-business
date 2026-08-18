import { describe, expect, it } from 'vitest'
import {
  applicableAddenda,
  isAddendumKey,
  leaseDocumentBlocks,
  orderedSigners,
  unknownLeaseMergeFields,
} from './index.ts'

describe('applicableAddenda', () => {
  const base = {
    yearBuilt: 2020,
    hasPool: false,
    hasWellOrSeptic: false,
    moldHistoryNotes: null,
    bedbugHistoryNotes: null,
    hasHoa: false,
  }

  it('triggers nothing for a plain, newer property with no history', () => {
    expect(applicableAddenda(base)).toEqual([])
  })

  it('triggers lead paint for a pre-1978 property', () => {
    expect(applicableAddenda({ ...base, yearBuilt: 1965 })).toEqual(['LEAD_PAINT'])
  })

  it('triggers lead paint when the build year is unknown - the wrong direction to be wrong in is silence', () => {
    expect(applicableAddenda({ ...base, yearBuilt: null })).toEqual(['LEAD_PAINT'])
  })

  it('triggers mold/bedbug only when there is recorded history, not on blank strings', () => {
    expect(applicableAddenda({ ...base, moldHistoryNotes: '  ' })).toEqual([])
    expect(applicableAddenda({ ...base, moldHistoryNotes: 'Treated 2019' })).toEqual(['MOLD'])
    expect(applicableAddenda({ ...base, bedbugHistoryNotes: 'Unit 3B, 2024' })).toEqual(['BEDBUG'])
  })

  it('triggers every property fact independently, in a stable order', () => {
    expect(
      applicableAddenda({
        yearBuilt: 1950,
        hasPool: true,
        hasWellOrSeptic: true,
        moldHistoryNotes: 'x',
        bedbugHistoryNotes: 'y',
        hasHoa: true,
      }),
    ).toEqual(['LEAD_PAINT', 'MOLD', 'BEDBUG', 'HOA_RULES', 'POOL', 'WELL_SEPTIC'])
  })
})

describe('isAddendumKey', () => {
  it('accepts only the closed list', () => {
    expect(isAddendumKey('POOL')).toBe(true)
    expect(isAddendumKey('NOT_A_KEY')).toBe(false)
  })
})

describe('orderedSigners', () => {
  it('puts the primary tenant first, then other tenants, then guarantors', () => {
    const signers = orderedSigners({
      primaryTenant: { id: 't1', name: 'Jordan Blake' },
      otherTenants: [{ id: 't2', name: 'Sam Rivera' }],
      guarantors: [{ id: 'g1', name: 'Pat Rivera' }],
    })
    expect(signers).toEqual([
      { order: 1, role: 'TENANT', name: 'Jordan Blake', tenantId: 't1' },
      { order: 2, role: 'TENANT', name: 'Sam Rivera', tenantId: 't2' },
      { order: 3, role: 'GUARANTOR', name: 'Pat Rivera', guarantorId: 'g1' },
    ])
  })

  it('handles no primary tenant and no guarantors', () => {
    expect(orderedSigners({ primaryTenant: null, otherTenants: [], guarantors: [] })).toEqual([])
  })
})

describe('unknownLeaseMergeFields', () => {
  it('accepts every catalogued field and flags anything else', () => {
    expect(unknownLeaseMergeFields('Rent is {{rent.amount}} due day {{rent.due_day}}.')).toEqual([])
    expect(unknownLeaseMergeFields('Tenant id is {{tenant.internalId}}.')).toEqual([
      'tenant.internalid',
    ])
  })
})

describe('leaseDocumentBlocks', () => {
  function facts(over: Partial<Parameters<typeof leaseDocumentBlocks>[0]> = {}) {
    return {
      propertyName: 'Cedar Row',
      propertyAddress: '18 Cedar Row',
      unitName: 'Unit B',
      startsOn: '2026-09-01',
      endsOn: '2027-08-31',
      rentAmount: '$1,600.00',
      depositAmount: '$1,600.00',
      generatedOn: '2026-08-18',
      bodyText: 'This is the lease body.\n\nSecond paragraph.',
      addenda: [],
      utilities: { water: 'LANDLORD', electricity: 'TENANT' } as const,
      utilityLabels: { water: 'Water', electricity: 'Electricity' },
      signers: [
        { order: 1, role: 'TENANT' as const, name: 'Jordan Blake', signedAt: null, signedName: null },
      ],
      ...over,
    }
  }

  it('opens with the title and the term/rent/deposit meta', () => {
    const blocks = leaseDocumentBlocks(facts())
    expect(blocks[0]).toEqual({ kind: 'heading', text: 'Residential Lease Agreement' })
    expect(blocks.some((b) => b.kind === 'meta' && b.text.includes('$1,600.00'))).toBe(true)
  })

  it('lists only utilities the lease actually assigns, never NOT_APPLICABLE', () => {
    const blocks = leaseDocumentBlocks(
      facts({ utilities: { water: 'LANDLORD', trash: 'NOT_APPLICABLE' } }),
    )
    const mono = blocks.filter((b) => b.kind === 'mono').map((b) => b.text)
    expect(mono.some((t) => t.includes('Water'))).toBe(true)
    expect(mono.some((t) => t.includes('Trash') || t.includes('trash'))).toBe(false)
  })

  it('shows an unsigned signer as not yet signed and a signed one with the typed name and timestamp', () => {
    const blocks = leaseDocumentBlocks(
      facts({
        signers: [
          { order: 1, role: 'TENANT', name: 'Jordan Blake', signedAt: null, signedName: null },
          {
            order: 2,
            role: 'GUARANTOR',
            name: 'Pat Rivera',
            signedAt: '2026-08-19T12:00:00.000Z',
            signedName: 'Patricia Rivera',
          },
        ],
      }),
    )
    const meta = blocks.filter((b) => b.kind === 'meta').map((b) => b.text)
    expect(meta).toContain('Tenant 1: Jordan Blake — not yet signed')
    expect(meta.some((t) => t.includes('Guarantor 2: Patricia Rivera — signed electronically'))).toBe(
      true,
    )
  })

  it('always ends with the standing disclaimer', () => {
    const blocks = leaseDocumentBlocks(facts())
    expect(blocks[blocks.length - 1]).toEqual({
      kind: 'footer',
      text: expect.stringContaining('has not been reviewed by an attorney'),
    })
  })
})
