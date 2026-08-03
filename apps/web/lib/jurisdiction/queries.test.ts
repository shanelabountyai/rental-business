import { prisma } from '@rental/db'
import { afterAll, describe, expect, it } from 'vitest'
import {
  JurisdictionRuleNotFoundError,
  currentRuleVersion,
  listCurrentRules,
  listRuleVersions,
  rulesFor,
} from './queries.ts'

// Against a real database, and a fake state code ("ZZ") rather than a real
// one - the real seed data (TX, statewide, v1) must be left alone by every
// test file that runs against the same dev database.

const created: string[] = []

async function makeRule(data: {
  jurisdiction?: string | null
  version: number
  effectiveFrom: string
  effectiveTo?: string | null
}) {
  const row = await prisma.jurisdictionRule.create({
    data: {
      state: 'ZZ',
      jurisdiction: data.jurisdiction ?? null,
      version: data.version,
      effectiveFrom: new Date(data.effectiveFrom),
      effectiveTo: data.effectiveTo ? new Date(data.effectiveTo) : null,
      graceDays: data.version, // distinguishes rows in assertions
      lateFeeType: 'NONE',
      depositEscrowRequired: false,
      depositInterestRequired: false,
      justCauseRequired: false,
      paymentAllocationOrder: ['RENT'],
      rubsPermitted: true,
    },
  })
  created.push(row.id)
  return row
}

afterAll(async () => {
  await prisma.jurisdictionRule.deleteMany({ where: { id: { in: created } } })
  await prisma.$disconnect()
})

describe('rulesFor', () => {
  it('resolves the version in force on the given day', async () => {
    await makeRule({
      version: 1,
      effectiveFrom: '2025-01-01',
      effectiveTo: '2025-12-31',
    })
    await makeRule({ version: 2, effectiveFrom: '2026-01-01' })

    const rule = await rulesFor({ state: 'ZZ' }, new Date('2025-06-01'))
    expect(rule.graceDays).toBe(1)

    const later = await rulesFor({ state: 'ZZ' }, new Date('2026-06-01'))
    expect(later.graceDays).toBe(2)
  })

  it('prefers a county ordinance in force over the statewide rule', async () => {
    await makeRule({ jurisdiction: 'Testopolis', version: 1, effectiveFrom: '2026-01-01' })

    const rule = await rulesFor(
      { state: 'ZZ', county: 'Testopolis' },
      new Date('2026-06-01'),
    )
    // The county row's own version 1, distinct from statewide's version 2.
    expect(rule.jurisdiction).toBe('Testopolis')
  })

  it('throws for a state with no configuration at all', async () => {
    await expect(rulesFor({ state: 'YY' }, new Date())).rejects.toThrow(
      JurisdictionRuleNotFoundError,
    )
  })
})

describe('listCurrentRules', () => {
  it('includes exactly the currently-effective row per group, not superseded ones', async () => {
    const rules = await listCurrentRules(new Date('2026-06-01'))
    const zz = rules.filter((r) => r.state === 'ZZ')

    // Statewide (jurisdiction null) and the Testopolis ordinance are two
    // separate groups; each contributes exactly one row.
    expect(zz).toHaveLength(2)
    const statewide = zz.find((r) => r.jurisdiction == null)
    expect(statewide?.version).toBe(2)
    const county = zz.find((r) => r.jurisdiction === 'Testopolis')
    expect(county?.version).toBe(1)
  })
})

describe('listRuleVersions', () => {
  it('returns every version for a pair, newest first', async () => {
    const versions = await listRuleVersions('ZZ', null)
    expect(versions.map((v) => v.version)).toEqual([2, 1])
  })
})

describe('currentRuleVersion', () => {
  it('returns the open-ended row', async () => {
    const current = await currentRuleVersion('ZZ', null)
    expect(current?.version).toBe(2)
    expect(current?.effectiveTo).toBeNull()
  })

  it('returns null when nothing has been configured', async () => {
    expect(await currentRuleVersion('YY', null)).toBeNull()
  })
})
