'use server'

import { type AuditAction, recordAudit } from '@rental/core/audit'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import {
  AREA_CODE,
  type TwilioRow,
  pollTwilioProvisioning,
  retireTwilioProvisioning,
  startTwilioProvisioning,
} from '@/lib/integrations/twilio-provisioning.ts'
import {
  DOMAIN,
  type ResendRow,
  pollResendProvisioning,
  retireResendProvisioning,
  startResendProvisioning,
} from '@/lib/integrations/resend-provisioning.ts'
import {
  type DomainRow,
  pollDomainProvisioning,
  retireDomainProvisioning,
  startDomainProvisioning,
} from '@/lib/integrations/vercel-domain.ts'
import { requirePlatform } from '@/lib/platform/guard.ts'
import type { OrgInviteFormState } from '@/lib/platform/org-actions.ts'

// The integrations panel on `/platform/orgs/[slug]` (PRD 11 §3.1, §4.4,
// R-292b, R-293b, R-276): start, re-poll or retire an org's Twilio
// provisioning, its Resend sending domain or its custom domain. Guarded by
// `integration.provision`, which wants no step-up; audited in the org as
// PLATFORM. Nothing here reads the sealed secret, and no audit row carries it.

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

const words = (status: string | undefined) => (status ?? 'unknown').toLowerCase().replaceAll('_', ' ')

/// What an audit row may say about the row: never the secret, which
/// `TwilioRow` does not carry anyway.
function shown(row: TwilioRow) {
  const { accountSid, phoneNumber, brandStatus, campaignStatus } = row.config
  return { status: row.status, statusReason: row.statusReason, accountSid, phoneNumber, brandStatus, campaignStatus }
}

type Audit = (
  action: AuditAction,
  row: { id: string },
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
) => Promise<unknown>

/// The guard, the org by slug, and an audit writer in that org as PLATFORM.
async function provisionTarget(slug: string): Promise<{ org: { id: string }; audit: Audit } | null> {
  const actor = await requirePlatform({
    permission: 'integration.provision',
    next: `/platform/orgs/${encodeURIComponent(slug)}`,
  })
  const org = await prisma.organization.findUnique({ where: { slug }, select: { id: true } })
  if (!org) return null
  const audit: Audit = async (action, row, before, after) =>
    recordAudit(prisma, {
      actor: { type: 'PLATFORM', ref: actor.id, ipAddress: (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown' },
      action,
      entityType: 'OrgIntegration',
      entityId: row.id,
      orgId: org.id,
      before: before ?? undefined,
      after,
    })
  return { org, audit }
}

export async function provisionTwilio(
  _previous: OrgInviteFormState,
  formData: FormData,
): Promise<OrgInviteFormState> {
  const slug = str(formData, 'slug')
  const target = await provisionTarget(slug)
  if (!target) return { error: 'That organisation no longer exists.' }
  const { org, audit } = target
  const intent = str(formData, 'intent')

  let notice: string
  if (intent === 'start') {
    const areaCode = str(formData, 'areaCode')
    if (!AREA_CODE.test(areaCode)) {
      return { error: 'Fix the area code.', fieldErrors: { areaCode: 'Three digits, not starting with 0 or 1.' } }
    }
    const started = await startTwilioProvisioning(org.id, areaCode)
    if (!started.ok) return { error: started.error }
    await audit('integration.provision_started', started.row, null, shown(started.row))
    notice = `SMS provisioning started on ${started.row.config.phoneNumber}. The brand registration is pending.`
  } else if (intent === 'poll') {
    const polled = await pollTwilioProvisioning(org.id).catch((error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
    )
    if (polled instanceof Error) return { error: `Twilio did not answer the poll: ${polled.message}` }
    if (!polled) return { notice: 'Nothing to re-poll: provisioning is not in progress.' }
    await audit('integration.polled', polled.after, shown(polled.before), shown(polled.after))
    const { brandStatus, campaignStatus } = polled.after.config
    notice = `Re-polled. Brand ${words(brandStatus)}, campaign ${campaignStatus ? words(campaignStatus) : 'not registered yet'}.`
  } else if (intent === 'retire') {
    const retired = await retireTwilioProvisioning(org.id)
    if (!retired) return { notice: 'SMS was already retired.' }
    await audit('integration.retired', retired.before, shown(retired.before), { status: 'RETIRED' })
    notice = 'SMS retired. The subaccount is closed and its number released; no texts go out for this organisation.'
  } else {
    return { error: 'That action is not recognised.' }
  }
  revalidatePath(`/platform/orgs/${slug}`)
  revalidatePath('/platform/orgs')
  return { notice }
}

/// What an audit row may say about a RESEND row: never the sealed key or
/// inbound secret, which `ResendRow` does not carry anyway.
function shownDomain(row: ResendRow) {
  const { domain, domainId, domainStatus, from, inboundAddress } = row.config
  return { status: row.status, statusReason: row.statusReason, domain, domainId, domainStatus, from, inboundAddress }
}

export async function provisionResend(
  _previous: OrgInviteFormState,
  formData: FormData,
): Promise<OrgInviteFormState> {
  const slug = str(formData, 'slug')
  const target = await provisionTarget(slug)
  if (!target) return { error: 'That organisation no longer exists.' }
  const { org, audit } = target
  const intent = str(formData, 'intent')

  let notice: string
  if (intent === 'start') {
    const domain = str(formData, 'domain').toLowerCase()
    if (!DOMAIN.test(domain)) {
      return { error: 'Fix the sending domain.', fieldErrors: { domain: 'A hostname such as mail.example.com.' } }
    }
    const started = await startResendProvisioning(org.id, domain)
    if (!started.ok) return { error: started.error }
    await audit('integration.provision_started', started.row, null, shownDomain(started.row))
    notice = `Domain ${domain} added. Publish the DNS records below, then re-poll.`
  } else if (intent === 'poll') {
    const polled = await pollResendProvisioning(org.id).catch((error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
    )
    if (polled instanceof Error) return { error: `Resend did not answer the poll: ${polled.message}` }
    if (!polled) return { notice: 'Nothing to re-poll: provisioning is not in progress.' }
    await audit('integration.polled', polled.after, shownDomain(polled.before), shownDomain(polled.after))
    notice = `Re-polled. Domain ${words(polled.after.config.domainStatus)}.`
  } else if (intent === 'retire') {
    const retired = await retireResendProvisioning(org.id)
    if (!retired) return { notice: 'The email domain was already retired.' }
    await audit('integration.retired', retired.before, shownDomain(retired.before), { status: 'RETIRED' })
    notice = 'Email domain retired. Email now goes from the shared address under this organisation\'s name.'
  } else {
    return { error: 'That action is not recognised.' }
  }
  revalidatePath(`/platform/orgs/${slug}`)
  revalidatePath('/platform/orgs')
  return { notice }
}

/// What an audit row may say about a VERCEL row. It has no secret.
function shownCustomDomain(row: DomainRow) {
  const { domain, verifiedAt } = row.config
  return { status: row.status, statusReason: row.statusReason, domain, verifiedAt }
}

/// The custom domain panel (R-276): start, re-poll or retire, as for Resend.
export async function provisionDomain(
  _previous: OrgInviteFormState,
  formData: FormData,
): Promise<OrgInviteFormState> {
  const slug = str(formData, 'slug')
  const target = await provisionTarget(slug)
  if (!target) return { error: 'That organisation no longer exists.' }
  const { org, audit } = target
  const intent = str(formData, 'intent')

  let notice: string
  if (intent === 'start') {
    const domain = str(formData, 'domain').toLowerCase()
    if (!DOMAIN.test(domain)) {
      return { error: 'Fix the custom domain.', fieldErrors: { domain: 'A hostname such as portal.example.com.' } }
    }
    const started = await startDomainProvisioning(org.id, domain)
    if (!started.ok) return { error: started.error }
    await audit('integration.provision_started', started.row, null, shownCustomDomain(started.row))
    notice = `Domain ${domain} added. Publish the DNS records below, then re-poll.`
  } else if (intent === 'poll') {
    const polled = await pollDomainProvisioning(org.id).catch((error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
    )
    if (polled instanceof Error) return { error: `Vercel did not answer the poll: ${polled.message}` }
    if (!polled) return { notice: 'Nothing to re-poll: provisioning is not in progress.' }
    await audit('integration.polled', polled.after, shownCustomDomain(polled.before), shownCustomDomain(polled.after))
    notice =
      polled.after.status === 'VERIFIED'
        ? `Re-polled. ${polled.after.config.domain} is verified and now serves this organisation.`
        : `Re-polled. Not verified yet${polled.after.statusReason ? `: ${polled.after.statusReason}` : '.'}`
  } else if (intent === 'retire') {
    const retired = await retireDomainProvisioning(org.id)
    if (!retired) return { notice: 'The custom domain was already retired.' }
    await audit('integration.retired', retired.before, shownCustomDomain(retired.before), { status: 'RETIRED' })
    notice = 'Custom domain retired. Links now go to this organisation’s subdomain.'
  } else {
    return { error: 'That action is not recognised.' }
  }
  revalidatePath(`/platform/orgs/${slug}`)
  revalidatePath('/platform/orgs')
  return { notice }
}
