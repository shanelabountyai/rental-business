import { describe, expect, it } from 'vitest'
import { platformSettings } from './settings.ts'

// PRD 11 §4.12 (R-303b): a secret's value never reaches the page.
const SECRETS = {
  NOTIFICATIONS_SANDBOX_TO: 'sandbox@secret-value.test',
  DEMO_ACCESS_PASSWORD: 'secret-value-demo',
  CRON_SECRET: 'secret-value-cron',
  STRIPE_SECRET_KEY: 'sk_live_secret-value-stripe',
  STRIPE_WEBHOOK_SECRET: 'whsec_secret-value',
  TWILIO_AUTH_TOKEN: 'secret-value-twilio',
  RESEND_WEBHOOK_SECRET: 'secret-value-resend',
  INBOUND_EMAIL_SECRET: 'secret-value-inbound',
  AUTH_SECRET: 'secret-value-auth-0123456789',
}

const shown = (env: Record<string, string | undefined>) =>
  Object.fromEntries(platformSettings(env).map((l) => [l.name, l.shown]))

describe('platformSettings', () => {
  it('never shows a secret value, only that it is set', () => {
    const lines = platformSettings({ ...SECRETS, PLATFORM_HOST: 'platform.example.test' })
    expect(JSON.stringify(lines)).not.toContain('secret-value')
    expect(shown(SECRETS)).toMatchObject({ CRON_SECRET: 'set', AUTH_SECRET: 'set', STRIPE_SECRET_KEY: 'live mode' })
  })

  it('shows hostnames, the environment and a short SHA as themselves', () => {
    expect(
      shown({ ORG_BASE_DOMAIN: 'example.test', PLATFORM_HOST: 'platform.example.test', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_SHA: 'abcdef0123456789' }),
    ).toMatchObject({ ORG_BASE_DOMAIN: 'example.test', PLATFORM_HOST: 'platform.example.test', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_SHA: 'abcdef0' })
  })

  it('reads the kill switch and the Stripe mode the way the app does', () => {
    expect(shown({}).NOTIFICATIONS_ENABLED).toBe('on')
    expect(shown({ NOTIFICATIONS_ENABLED: 'false' }).NOTIFICATIONS_ENABLED).toBe('off')
    expect(shown({}).STRIPE_SECRET_KEY).toBe('unset (simulator)')
    expect(shown({ STRIPE_SECRET_KEY: 'sk_test_x' }).STRIPE_SECRET_KEY).toBe('test mode')
    expect(shown({ CRON_SECRET: '' }).CRON_SECRET).toBe('unset')
  })
})
