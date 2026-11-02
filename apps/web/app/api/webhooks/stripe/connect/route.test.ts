import { randomUUID } from 'node:crypto'
import { stripeSignatureHeader } from '@rental/core/billing'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getBillingProvider } from '@/lib/billing/provider.ts'
import { CollectionRefusedError } from '@/lib/integrations/stripe-onboarding.ts'
import { saveOrgIntegration } from '@/lib/integrations/store.ts'
import { POST as connect } from './route.ts'
import { POST as platform } from '../route.ts'

// R-277a (D-316, PRD 10 §2.4). The Connect endpoint names the org from the
// signed `event.account`; the platform endpoint is org #0's and refuses an
// event that names a connected account. Driven through the real routes with
// real signatures, because the signature is the whole boundary.
//
// The events are a type the pipeline ignores, so the claim row is the only
// thing written - and `ProcessedStripeEvent` is not append-only, so it can be
// cleaned up.

const PLATFORM_SECRET = 'whsec_platform_r277a'
const CONNECT_SECRET = 'whsec_connect_r277a'
const stamp = `r277a-${randomUUID().slice(0, 8)}`
const ACCOUNT = `acct_${stamp}`
let orgA = ''
const eventIds: string[] = []
const previous = {
  platform: process.env.STRIPE_WEBHOOK_SECRET,
  connect: process.env.STRIPE_CONNECT_WEBHOOK_SECRET,
  key: process.env.STRIPE_SECRET_KEY,
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeAll(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = PLATFORM_SECRET
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET
  orgA = (await prisma.organization.create({ data: { slug: stamp, name: `${stamp} A` } })).id
  await saveOrgIntegration(orgA, 'STRIPE', { status: 'ENABLED', config: { accountId: ACCOUNT } })
})

afterAll(async () => {
  restore('STRIPE_WEBHOOK_SECRET', previous.platform)
  restore('STRIPE_CONNECT_WEBHOOK_SECRET', previous.connect)
  restore('STRIPE_SECRET_KEY', previous.key)
  await prisma.processedStripeEvent.deleteMany({ where: { stripeEventId: { in: eventIds } } })
  await prisma.orgIntegration.deleteMany({ where: { orgId: orgA } })
  await prisma.organization.deleteMany({ where: { id: orgA } })
})

function event(id: string, account?: string) {
  eventIds.push(id)
  return {
    id,
    type: 'customer.discount.created',
    created: Math.floor(Date.now() / 1000),
    data: { object: {} },
    ...(account ? { account } : {}),
  }
}

function post(body: object, secret: string) {
  const rawBody = JSON.stringify(body)
  const header = stripeSignatureHeader({ rawBody, secret, timestamp: Math.floor(Date.now() / 1000) })
  return new Request('https://rental.example.test/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'stripe-signature': header, 'content-type': 'application/json' },
    body: rawBody,
  })
}

const claims = (stripeEventId: string) =>
  prisma.processedStripeEvent.findMany({ where: { stripeEventId }, select: { orgId: true } })

describe('the Connect webhook', () => {
  it("claims a connected account's event under that account's org", async () => {
    const id = `evt_${stamp}_a`
    const response = await connect(post(event(id, ACCOUNT), CONNECT_SECRET))
    expect(response.status).toBe(200)
    expect(await claims(id)).toEqual([{ orgId: orgA }])
  })

  it('lets the same event id exist once per org, because Stripe ids are unique per account', async () => {
    const id = `evt_${stamp}_shared`
    await connect(post(event(id, ACCOUNT), CONNECT_SECRET))
    await platform(post(event(id), PLATFORM_SECRET))
    const orgs = (await claims(id)).map((row) => row.orgId).sort()
    expect(orgs).toEqual([orgA, 'org_0'].sort())
  })

  it('acknowledges and drops an account no org holds, without claiming it', async () => {
    const id = `evt_${stamp}_stranger`
    const response = await connect(post(event(id, `acct_nobody_${stamp}`), CONNECT_SECRET))
    expect(response.status).toBe(200)
    expect(await claims(id)).toEqual([])
  })

  it('drops an event that names no account', async () => {
    const id = `evt_${stamp}_noacct`
    expect((await connect(post(event(id), CONNECT_SECRET))).status).toBe(200)
    expect(await claims(id)).toEqual([])
  })

  it("refuses the platform endpoint's secret", async () => {
    const id = `evt_${stamp}_wrongsecret`
    expect((await connect(post(event(id, ACCOUNT), PLATFORM_SECRET))).status).toBe(400)
    expect(await claims(id)).toEqual([])
  })
})

describe('the platform webhook', () => {
  it("drops an event naming a connected account rather than booking it as org #0's", async () => {
    const id = `evt_${stamp}_misrouted`
    expect((await platform(post(event(id, ACCOUNT), PLATFORM_SECRET))).status).toBe(200)
    expect(await claims(id)).toEqual([])
  })
})

describe("an org's billing provider", () => {
  it('refuses an org with no connected account rather than billing on the platform account', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_r277a'
    const orgB = `${orgA}-unconnected`
    await expect(getBillingProvider(orgB).createSetupIntent('cus_x')).rejects.toBeInstanceOf(
      // R-277b: refused by the collection gate before the header is resolved.
      CollectionRefusedError,
    )
    restore('STRIPE_SECRET_KEY', previous.key)
  })
})
