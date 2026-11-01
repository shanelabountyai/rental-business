import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { saveOrgIntegration } from '@/lib/integrations/store.ts'
import { POST } from './route.ts'

// R-293 (PRD 10 §M5). The org is the host the provider posted to, and the
// secret must be THAT org's: org #0's env secret on org A's host, or org A's
// on org #0's, is refused. The secret is the whole authentication story for
// this public endpoint, so these drive the real route.

const ENV_SECRET = 'test-env-inbound-r293'
const ORG_SECRET = 'test-org-inbound-r293'
const BASE = 'orgs.r293.example.test'
const stamp = `r293-${randomUUID().slice(0, 8)}`
let orgA = ''
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const [key, value] of Object.entries({ INBOUND_EMAIL_SECRET: ENV_SECRET, ORG_BASE_DOMAIN: BASE })) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  orgA = (await prisma.organization.create({ data: { slug: stamp, name: `${stamp} A` } })).id
  await saveOrgIntegration(orgA, 'RESEND', {
    config: { inboundAddress: `hello@${stamp}.example.test` },
    secret: JSON.stringify({ inboundSecret: ORG_SECRET }),
  })
})

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await prisma.unroutedMessage.deleteMany({ where: { orgId: orgA } })
  await prisma.orgIntegration.deleteMany({ where: { orgId: orgA } })
  await prisma.organization.deleteMany({ where: { id: orgA } })
})

function mail(host: string, secret: string) {
  return POST(
    new Request(`https://${host}/api/email/inbound`, {
      method: 'POST',
      headers: { host, 'x-inbound-secret': secret, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: `Stranger <stranger-${stamp}@example.test>`,
        to: `hello@${stamp}.example.test`,
        text: 'Is the house on Elm still available?',
        messageId: `<${randomUUID()}@example.test>`,
      }),
    }),
  )
}

describe('POST /api/email/inbound per org (R-293)', () => {
  it("files mail on the org's host, with the org's secret, in that org's queue", async () => {
    const response = await mail(`${stamp}.${BASE}`, ORG_SECRET)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ outcome: 'unrouted' })
    expect(await prisma.unroutedMessage.count({ where: { orgId: orgA } })).toBe(1)
  })

  it("refuses org #0's env secret on the org's host", async () => {
    expect((await mail(`${stamp}.${BASE}`, ENV_SECRET)).status).toBe(403)
  })

  it("refuses the org's secret on org #0's host", async () => {
    expect((await mail('localhost:3100', ORG_SECRET)).status).toBe(403)
  })

  it('refuses a host that names no org, without retry', async () => {
    expect((await mail(`no-such-${stamp}.${BASE}`, ORG_SECRET)).status).toBe(403)
    expect((await mail(BASE, ORG_SECRET)).status).toBe(403)
  })
})
