import { describe, expect, it } from 'vitest'
import {
  BLANK,
  type HandoffFile,
  type HandoffLease,
  depositTotalCents,
  depositTransferDraft,
  estoppelCertificateBlocks,
  handoffPacketBlocks,
} from './handoff.ts'

// The sale / acquisition handoff packet (DOC-06, RISK-09; R-092).

const lease: HandoffLease = {
  leaseId: 'lease_1',
  unitName: 'House',
  tenantNames: ['Ada Tenant', 'Bo Tenant'],
  status: 'ACTIVE',
  startsOn: '2026-01-01',
  endsOn: '2026-12-31',
  isMonthToMonth: false,
  rentCents: 165_000,
  rentDueDay: 1,
  depositHeldCents: 165_000,
  balanceCents: 0,
  noticeEffectiveOn: null,
}

const file: HandoffFile = {
  propertyName: 'Quiet Lane',
  addressLine1: '4 Quiet Lane',
  addressLine2: null,
  city: 'Houston',
  state: 'TX',
  postalCode: '77002',
  entityName: 'Seller Holdings LLC',
  propertyType: 'SINGLE_FAMILY',
  yearBuilt: 2015,
  units: [{ name: 'House', status: 'OCCUPIED', bedrooms: 3, bathrooms: 2 }],
  leases: [lease],
  accessCodes: [
    { unitName: 'House', type: 'LOCKBOX', label: 'Front lockbox', issuedOn: '2026-02-01' },
  ],
  vendorJobs: [
    { completedOn: '2026-03-04', vendorName: 'Ace Plumbing', scope: 'Replace water heater', costCents: 128_500 },
  ],
  warranties: [
    {
      category: 'ROOF',
      provider: 'Sunbelt Roofing',
      coverageSummary: 'Twenty-year workmanship warranty on the 2021 re-roof.',
      expiresOn: '2041-06-30',
    },
  ],
  hoa: { association: 'Quiet Lane HOA', hasRentalCap: false, rentalCapPolicy: null },
  exhibits: [],
  generatedAt: '4 May 2026, 09:00',
  generatedBy: 'Sam Owner',
  timezone: 'America/Chicago',
}

const textOf = (blocks: readonly { text: string }[]) => blocks.map((b) => b.text).join('\n')

describe('the deposit-transfer notice draft', () => {
  const draft = depositTransferDraft({
    tenantNames: ['Ada Tenant'],
    addressLine1: '4 Quiet Lane',
    unitName: 'House',
    depositHeldCents: 165_000,
    sellerEntityName: 'Seller Holdings LLC',
  }).join('\n')

  it('names the amount held and who held it', () => {
    expect(draft).toContain('$1,650.00')
    expect(draft).toContain('Seller Holdings LLC')
    expect(draft).toContain('Ada Tenant')
  })

  it('leaves the buyer, the address and the date BLANK rather than inventing them', () => {
    // The failure this exists to prevent: a "template" carrying a plausible
    // invented buyer name reads as a finished letter, and somebody sends it.
    // Five blanks — buyer, closing date, letter date, and the address block.
    expect(draft.split(BLANK).length - 1).toBeGreaterThanOrEqual(5)
    expect(draft).not.toMatch(/Buyer (LLC|Inc|Holdings)/)
  })

  it('tells the tenant the lease is unaffected, which is the thing they will ask', () => {
    expect(draft).toContain('continues unchanged')
    expect(draft).toContain('unaffected by the sale')
  })
})

describe('the estoppel certificate', () => {
  const build = (overrides: Partial<HandoffLease> = {}) =>
    textOf(
      estoppelCertificateBlocks({
        lease: { ...lease, ...overrides },
        addressLine1: file.addressLine1,
        city: file.city,
        state: file.state,
        postalCode: file.postalCode,
        entityName: file.entityName,
        generatedAt: file.generatedAt,
        generatedBy: file.generatedBy,
        timezone: file.timezone,
      }),
    )

  it('states the figures as the LANDLORD’s record and asks for corrections', () => {
    // A certificate presenting our own numbers as agreed fact defeats its own
    // purpose: what a buyer relies on it for is exactly the places it differs.
    const text = build()
    expect(text).toContain('the landlord’s records say')
    expect(text).toContain('Corrections')
    expect(text).toContain('correct it below rather than signing over it')
  })

  it('reads the balance in the direction it actually runs', () => {
    expect(build({ balanceCents: 0 })).toContain('Nothing owed and nothing in credit')
    expect(build({ balanceCents: 45_000 })).toContain('$450.00 owed by the tenant')
    // The sign matters: a credit printed as "owed" hands the buyer a debt
    // that is really the tenant's money.
    expect(build({ balanceCents: -45_000 })).toContain('$450.00 held in credit for the tenant')
  })

  it('names notice already given, and says so where there is none', () => {
    expect(build({ noticeEffectiveOn: '2026-09-19' })).toContain(
      'the tenancy ends 19 Sept 2026',
    )
    expect(build()).toContain('None on file')
  })

  it('gives every tenant their own signature line', () => {
    const text = build()
    expect(text).toContain('Ada Tenant')
    expect(text).toContain('Bo Tenant')
  })

  it('says it is a draft and not legal advice', () => {
    expect(build()).toContain('not legal advice')
  })
})

describe('the handoff packet', () => {
  it('says what is deliberately not in it, up front', () => {
    // Rather than leaving it to be discovered as a gap on page six.
    const text = textOf(handoffPacketBlocks(file))
    expect(text).toContain('What is deliberately not in here')
    expect(text).toContain('values are not printed')
    expect(text).toContain('neither transfers with the house')
  })

  it('inventories access codes without printing one', () => {
    const text = textOf(handoffPacketBlocks(file))
    expect(text).toContain('Front lockbox')
    expect(text).toContain('LOCKBOX')
    expect(text).toContain('released individually')
    // And tells the buyer to change them anyway, because a record retired is
    // not a lock changed — R-091's own lesson, arriving here.
    expect(text).toContain('change every one of them afterwards')
  })

  it('puts a tenancy already under notice in front of the reader', () => {
    const text = textOf(
      handoffPacketBlocks({ ...file, leases: [{ ...lease, noticeEffectiveOn: '2026-09-19' }] }),
    )
    // A buyer inheriting a tenancy that ends in three weeks is inheriting a
    // vacancy, and a packet that did not say so is the misrepresentation.
    expect(text).toContain('NOTICE GIVEN')
    expect(text).toContain('19 Sept 2026')
  })

  it('totals the deposits and says whose money it is', () => {
    expect(depositTotalCents(file.leases)).toBe(165_000)
    const text = textOf(handoffPacketBlocks(file))
    expect(text).toContain('$1,650.00 is held across 1 tenancy')
    expect(text).toContain('becomes the buyer’s liability at closing')
  })

  it('carries one transfer notice per tenancy', () => {
    const two = handoffPacketBlocks({
      ...file,
      leases: [lease, { ...lease, leaseId: 'lease_2', unitName: 'Garage flat' }],
    })
    expect(textOf(two).split('Your security deposit of').length - 1).toBe(2)
  })

  it('keeps three different HOA answers three different answers', () => {
    // Capped, not capped, and never asked. Skipping the section when there is
    // no record silently delivers the third as though it were the second, and
    // a rental cap is the one association fact that can make a buyer's whole
    // plan illegal.
    expect(textOf(handoffPacketBlocks(file))).toContain('imposes no rental cap')
    expect(
      textOf(handoffPacketBlocks({ ...file, hoa: { ...file.hoa!, hasRentalCap: true } })),
    ).toContain('its terms are not')
    expect(
      textOf(
        handoffPacketBlocks({
          ...file,
          hoa: { ...file.hoa!, hasRentalCap: true, rentalCapPolicy: 'No more than 10% of homes' },
        }),
      ),
    ).toContain('Rental cap: No more than 10% of homes')
    expect(textOf(handoffPacketBlocks({ ...file, hoa: null }))).toContain(
      'No association record was ever filled in',
    )
  })

  it('names the missing estoppels rather than shipping a packet that looks complete', () => {
    // D-50, and the emptyText is the one that tells a reader what to go and
    // do about it.
    expect(textOf(handoffPacketBlocks(file))).toContain(
      'No estoppel certificate has been generated',
    )
    const withOne = handoffPacketBlocks({
      ...file,
      exhibits: [
        { label: 'House — Ada Tenant', kind: 'Estoppel certificate', occurredOn: '4 May 2026', attached: false },
      ],
    })
    expect(textOf(withOne)).toContain('[NOT ATTACHED]')
  })

  it('renders a property with no tenancy, no code and no job without pretending otherwise', () => {
    const text = textOf(
      handoffPacketBlocks({
        ...file,
        leases: [],
        accessCodes: [],
        vendorJobs: [],
        warranties: [],
        hoa: null,
      }),
    )
    expect(text).toContain('No tenancy is running at this property.')
    expect(text).toContain('No access code is recorded')
    expect(text).toContain('No completed work order is recorded')
    expect(text).toContain('No warranty is recorded')
    expect(text).toContain('No tenancy, so no notice to give.')
  })
})
