import { prisma } from '@rental/db'
import { afterAll, describe, expect, it } from 'vitest'
import { recordOptIn, recordOptOut } from '@/lib/comms/opt-out-store.ts'
import { deliverOverChannel } from './deliver.ts'

// The shared suppression check (R-054, D-9's "shared, not per-path" logic
// applied to the carrier opt-out list). `sendThreadMessage()` went straight
// from "staff typed a reply" to a send with no opt-out check of its own -
// see deliver.ts's own header. This exercises the fix at the one place both
// `notify()` and `sendThreadMessage()` now share, rather than at either
// caller.

let phoneCounter = 0
function uniquePhone(): string {
  phoneCounter += 1
  const suffix = String(Date.now() % 100000).padStart(5, '0')
  return `+1512${suffix}${String(phoneCounter).padStart(2, '0')}`
}

const phones: string[] = []

afterAll(async () => {
  await prisma.smsOptOut.deleteMany({ where: { phone: { in: phones } } })
})

describe('deliverOverChannel and the shared SMS opt-out list', () => {
  it('refuses an SMS to a number that opted out', async () => {
    const phone = uniquePhone()
    phones.push(phone)
    await recordOptOut({ phone, source: 'INBOUND_KEYWORD', reason: 'STOP' })

    const outcome = await deliverOverChannel({ channel: 'SMS', to: phone, body: 'hello' })
    expect(outcome).toEqual({ status: 'SUPPRESSED', suppressedReason: 'sms_opt_out' })
  })

  it('sends again once the number opts back in', async () => {
    const phone = uniquePhone()
    phones.push(phone)
    await recordOptOut({ phone, source: 'INBOUND_KEYWORD', reason: 'STOP' })
    await recordOptIn({ phone, reason: 'START' })

    const outcome = await deliverOverChannel({ channel: 'SMS', to: phone, body: 'hello' })
    expect(outcome.status).toBe('SENT')
  })

  it('does not consult the opt-out list for a non-SMS channel', async () => {
    // The list holds phone numbers; checking it against an email address
    // would either always miss (harmless but pointless) or, worse, a
    // careless normalize could collide two unrelated identifiers.
    const outcome = await deliverOverChannel({
      channel: 'EMAIL',
      to: 'someone@example.test',
      subject: 'hi',
      body: 'hello',
    })
    expect(outcome.status).toBe('SENT')
  })
})
