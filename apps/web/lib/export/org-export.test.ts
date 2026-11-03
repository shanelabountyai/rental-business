import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildOrgExport, claimOrgExport } from './org-export.ts'

// R-299: the archive opens in a real unzip, carries only its own org's rows,
// and blanks the columns the audit log blanks.

const stamp = `export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const orgIds: string[] = []

async function orgWithEntity(tag: string) {
  const org = await prisma.organization.create({ data: { slug: `${stamp}-${tag}`, name: `Export Org ${tag}` } })
  orgIds.push(org.id)
  await prisma.legalEntity.create({ data: { orgId: org.id, name: `Entity ${stamp} ${tag}`, type: 'LLC' } })
  await prisma.orgInvite.create({
    data: {
      orgId: org.id,
      email: `${stamp}-${tag}@example.test`,
      name: 'Invitee',
      roleKey: 'owner',
      tokenHash: `hash-${stamp}-${tag}`,
      expiresAt: new Date(Date.now() + 86_400_000),
      invitedByType: 'PLATFORM',
      invitedById: 'test',
    },
  })
  return org.id
}

let orgA: string
let orgB: string

beforeAll(async () => {
  orgA = await orgWithEntity('a')
  orgB = await orgWithEntity('b')
})

afterAll(async () => {
  await prisma.orgInvite.deleteMany({ where: { orgId: { in: orgIds } } })
  await prisma.legalEntity.deleteMany({ where: { orgId: { in: orgIds } } })
  await prisma.jobRun.deleteMany({ where: { orgId: { in: orgIds } } })
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } })
})

function unzipped(archive: Buffer, entry: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'org-export-'))
  const file = join(dir, 'export.zip')
  writeFileSync(file, archive)
  execFileSync('unzip', ['-tq', file])
  return execFileSync('unzip', ['-p', file, entry], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

describe('buildOrgExport', () => {
  it("writes a valid zip of one org's rows, with a manifest, and redacts credentials", async () => {
    const { archive, manifest } = await buildOrgExport(orgA)
    const tables = (manifest as { tables: { table: string; file: string; rows: number }[] }).tables

    expect(tables.find((t) => t.table === 'Organization')?.rows).toBe(1)
    expect(tables.find((t) => t.table === 'LegalEntity')?.rows).toBe(1)
    const entities = tables.find((t) => t.table === 'LegalEntity')!
    const entityCsv = unzipped(archive, entities.file)
    expect(entityCsv).toContain(`Entity ${stamp} a`)
    expect(entityCsv).not.toContain(`Entity ${stamp} b`)

    const invites = unzipped(archive, tables.find((t) => t.table === 'OrgInvite')!.file)
    expect(invites).toContain('[redacted]')
    expect(invites).not.toContain(`hash-${stamp}-a`)

    expect(JSON.parse(unzipped(archive, 'manifest.json')).orgId).toBe(orgA)
    expect(tables.some((t) => t.table === 'PlatformAdmin')).toBe(false)
  })
})

describe('claimOrgExport', () => {
  it('allows one export per org per day, and another org its own', async () => {
    const first = await claimOrgExport(orgB)
    expect(first.ok).toBe(true)
    expect(await claimOrgExport(orgB)).toEqual({ ok: false, reason: 'running' })
    await prisma.jobRun.update({ where: { id: (first as { id: string }).id }, data: { status: 'FAILED' } })
    expect((await claimOrgExport(orgB)).ok).toBe(true)
    expect((await claimOrgExport(orgA)).ok).toBe(true)
  })
})
