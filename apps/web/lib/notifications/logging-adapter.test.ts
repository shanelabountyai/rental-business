import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoggingChannelAdapter } from './logging-adapter.ts'

// LEGAL-05. On a Vercel deployment the console is a runtime log, so nothing
// of the message may reach it - only the reference the delivery row stores.

const message = {
  channel: 'PORTAL' as const,
  to: 'derrick.holt@example.test',
  subject: 'Notice to vacate',
  body: 'You owe $1,850.00. Sign in: https://app.example.test/portal/verify?token=secret',
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function logged(): Promise<{ text: string; externalId?: string }> {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const { externalId } = await new LoggingChannelAdapter().send(message)
  return { text: info.mock.calls.flat().join('\n'), externalId }
}

describe('LoggingChannelAdapter', () => {
  it('logs only the reference on a Vercel deployment', async () => {
    vi.stubEnv('VERCEL', '1')
    const { text, externalId } = await logged()
    expect(text).toContain(externalId)
    for (const part of [message.to, message.subject, '1,850', 'token=secret']) {
      expect(text).not.toContain(part)
    }
  })

  it('prints the whole message on a laptop, where the demo walk reads it', async () => {
    vi.stubEnv('VERCEL', '')
    const { text } = await logged()
    expect(text).toContain(message.to)
    expect(text).toContain(message.body)
  })
})
