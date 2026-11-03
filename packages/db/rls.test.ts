import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrismaClient, localPoolCap } from './index.ts'
import { openOrgContext, withOrg, withRowLevelSecurity } from './rls.ts'

// R-287a: the policies bind, through every shape a query can take. Built on
// its own client so it does not depend on RLS_ENFORCE being set.

const base = new PrismaClient({ datasourceUrl: localPoolCap(process.env.DATABASE_URL) })
const db = withRowLevelSecurity(base)
const stamp = `rls-${process.pid}-${Date.now()}`
let orgA = ''
let orgB = ''
let entityB = ''

beforeAll(async () => {
  orgA = (await base.organization.create({ data: { slug: `${stamp}-a`, name: 'RLS A' } })).id
  orgB = (await base.organization.create({ data: { slug: `${stamp}-b`, name: 'RLS B' } })).id
  await base.legalEntity.create({ data: { orgId: orgA, name: `${stamp} A LLC`, type: 'LLC' } })
  entityB = (await base.legalEntity.create({ data: { orgId: orgB, name: `${stamp} B LLC`, type: 'LLC' } })).id
})

afterAll(async () => {
  await base.legalEntity.deleteMany({ where: { name: { startsWith: stamp } } })
  await base.organization.deleteMany({ where: { slug: { startsWith: stamp } } })
  await base.$disconnect()
})

const mine = { name: { startsWith: stamp } }

describe('row-level security (R-287a)', () => {
  it('no org in context is the connecting role: both orgs visible', async () => {
    expect(await db.legalEntity.count({ where: mine })).toBe(2)
  })

  it('a plain query sees only its org, even naming the other org', async () => {
    await withOrg(orgA, async () => {
      expect((await db.legalEntity.findMany({ where: mine })).map((e) => e.orgId)).toEqual([orgA])
      expect(await db.legalEntity.findFirst({ where: { id: entityB, orgId: orgB } })).toBeNull()
    })
  })

  it('a write into the other org is refused', async () => {
    await withOrg(orgA, async () => {
      await expect(
        db.legalEntity.create({ data: { orgId: orgB, name: `${stamp} forged`, type: 'LLC' } }),
      ).rejects.toThrow(/row-level security/)
      expect(await db.legalEntity.updateMany({ where: { id: entityB }, data: { name: `${stamp} moved` } })).toEqual({ count: 0 })
    })
  })

  it('an interactive transaction is enforced, and its tx works', async () => {
    await withOrg(orgA, () =>
      db.$transaction(async (tx) => {
        expect(await tx.legalEntity.count({ where: mine })).toBe(1)
        expect(await tx.$queryRaw<{ r: string }[]>`SELECT current_user AS r`).toEqual([{ r: 'rental_rls' }])
      }),
    )
  })

  it('a raw query inside a batch is enforced', async () => {
    const [, rows] = await withOrg(orgA, () =>
      db.$transaction([
        db.$executeRaw`SELECT 1`,
        db.$queryRaw<{ orgId: string }[]>`SELECT "orgId" FROM "LegalEntity" WHERE name LIKE ${`${stamp}%`}`,
      ]),
    )
    expect(rows).toEqual([{ orgId: orgA }])
  })

  it('a batch transaction is enforced', async () => {
    const [count, rows] = await withOrg(orgA, () =>
      db.$transaction([db.legalEntity.count({ where: mine }), db.legalEntity.findMany({ where: mine })]),
    )
    expect(count).toBe(1)
    expect(rows.map((e) => e.orgId)).toEqual([orgA])
  })

  it('raw queries are enforced too', async () => {
    const rows = await withOrg(orgB, () =>
      db.$queryRaw<{ orgId: string }[]>`SELECT "orgId" FROM "LegalEntity" WHERE name LIKE ${`${stamp}%`}`,
    )
    expect(rows).toEqual([{ orgId: orgB }])
  })

  it("a guard's context reaches its caller only when opened before the guard's await", async () => {
    const lookUpOrg = () => new Promise<string>((resolve) => setTimeout(() => resolve(orgB), 1))
    const guard = () => {
      const bind = openOrgContext()
      return lookUpOrg().then(bind)
    }
    const action = () =>
      withOrg('', async () => {
        await guard()
        return db.legalEntity.findMany({ where: mine, select: { orgId: true } })
      })
    expect(await action()).toEqual([{ orgId: orgB }])
  })

  it('the role and org do not leak past the transaction', async () => {
    await withOrg(orgA, () => db.legalEntity.count())
    expect(await base.$queryRaw<{ r: string; o: string | null }[]>`
      SELECT current_user AS r, NULLIF(current_setting('app.org_id', true), '') AS o`).toEqual([
      { r: expect.not.stringMatching(/^rental_rls$/), o: null },
    ])
  })
})
