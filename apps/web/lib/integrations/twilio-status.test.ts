import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { textingStatus } from './twilio-status.ts'

// R-273. Org #0 on the env account, Twilio stubbed by URL: the reader must
// pick toll-free verification for an 8xx number and the 10DLC campaign for a
// local one, and say "unreachable" rather than throw a settings page.

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function stubTwilio(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: string) => {
    const hit = Object.entries(routes).find(([path]) => url.includes(path))
    return hit ? json(hit[1]) : json({ message: 'not found' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC_test_sid')
  vi.stubEnv('TWILIO_AUTH_TOKEN', 'test_token')
  vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', 'MG_test_sid')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("the texting number's registration (R-273)", () => {
  it('reads toll-free verification for a toll-free number, with the rejection verbatim', async () => {
    const fetchMock = stubTwilio({
      '/PhoneNumbers': { phone_numbers: [{ sid: 'PN1', phone_number: '+18775550100' }] },
      '/Tollfree/Verifications': {
        verifications: [{ status: 'TWILIO_REJECTED', rejection_reason: 'Opt-in flow not shown' }],
      },
    })
    expect(await textingStatus('org_0')).toEqual({
      kind: 'toll_free',
      phoneNumber: '+18775550100',
      status: 'FAILED',
      reason: 'Opt-in flow not shown',
    })
    expect(String(fetchMock.mock.calls[1]![0])).toContain('TollfreePhoneNumberSid=PN1')
  })

  it('reads the 10DLC campaign for a local number', async () => {
    stubTwilio({
      '/PhoneNumbers': { phone_numbers: [{ sid: 'PN2', phone_number: '+19185550100' }] },
      '/Compliance/Usa2p': { compliance: [{ campaign_status: 'IN_PROGRESS' }] },
    })
    expect(await textingStatus('org_0')).toEqual({
      kind: '10dlc',
      phoneNumber: '+19185550100',
      status: 'IN_REVIEW',
      reason: null,
    })
  })

  it('says nothing was submitted when Twilio has no campaign', async () => {
    stubTwilio({
      '/PhoneNumbers': { phone_numbers: [{ sid: 'PN2', phone_number: '+19185550100' }] },
      '/Compliance/Usa2p': { compliance: [] },
    })
    expect(await textingStatus('org_0')).toMatchObject({ kind: '10dlc', status: null })
  })

  it('is unreachable, not a crash, when Twilio refuses', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    stubTwilio({})
    expect(await textingStatus('org_0')).toEqual({ kind: 'unreachable' })
  })

  it('is none when no sender is configured', async () => {
    vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', '')
    expect(await textingStatus('org_0')).toEqual({ kind: 'none' })
  })
})
