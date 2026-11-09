import 'server-only'

import { languageFor, renderTemplate } from '@rental/core/comms'
import type { TemplateKind } from '@rental/core/comms'
import { prisma } from '@rental/db'
import { actorCan, propertyResource } from '@/lib/auth/guard.ts'
import { templateValues } from './template-values.ts'
import type { TemplateAudience } from './template-values.ts'

// Reading and rendering managed templates (COMM-03, R-049).
//
// The write side lives in template-actions.ts, which is `'use server'` and may
// therefore export only async functions. This is the half both the pages and
// the actions read from.

export const TEMPLATE_SELECT = {
  id: true,
  name: true,
  kind: true,
  subject: true,
  body: true,
  active: true,
  updatedAt: true,
  translations: {
    select: {
      id: true,
      locale: true,
      subject: true,
      body: true,
      approvedAt: true,
      approvedBy: { select: { name: true } },
    },
    orderBy: { locale: 'asc' },
  },
} as const

// R-285b: a template belongs to one organisation (PRD 10 §M3), so every read
// names the org - by id included, so org A cannot open org B's template.
export async function listTemplates(orgId: string, includeRetired = false) {
  return prisma.messageTemplate.findMany({
    where: includeRetired ? { orgId } : { orgId, active: true },
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    select: TEMPLATE_SELECT,
  })
}

export async function getTemplate(id: string, orgId: string) {
  return prisma.messageTemplate.findFirst({ where: { id, orgId }, select: TEMPLATE_SELECT })
}

export interface RenderedForRecipient {
  subject: string | null
  body: string
  /// Merge fields the template asked for that this tenancy has no value for.
  /// NON-EMPTY MEANS DO NOT SEND — see `renderTemplate`.
  missing: string[]
  /// Which language version was used, and why. Surfaced rather than swallowed:
  /// `unapproved_translation_for_legal` is the only way anybody learns a
  /// translation needs review.
  language: ReturnType<typeof languageFor>
}

/**
 * Renders one template for one tenancy — the single path preview and send
 * both take.
 *
 * A PREVIEW BUILT FROM DIFFERENT CODE THAN THE SEND IS NOT A PREVIEW. It is a
 * second implementation that agrees with the first until the day it does not,
 * and that day is the day four hundred tenants get a message the PM never
 * saw. The preview screen passes a sample tenancy; the send passes the real
 * recipient. Nothing else differs.
 */
export async function renderForRecipient(
  template: {
    kind: string
    subject: string | null
    body: string
    translations: readonly {
      locale: string
      subject: string | null
      body: string
      approvedAt: Date | null
    }[]
  },
  audience: TemplateAudience,
): Promise<RenderedForRecipient | null> {
  const values = await templateValues(audience)
  if (!values) return null

  const language = languageFor(
    template.kind as TemplateKind,
    audience.preferredLocale,
    template.translations,
  )

  const source =
    language.use === 'translation'
      ? template.translations.find((t) => t.locale === language.locale)!
      : template

  const body = renderTemplate(source.body, values)
  const subject = source.subject ? renderTemplate(source.subject, values) : null

  return {
    subject: subject?.text ?? null,
    body: body.text,
    // Both halves, deduplicated. A field missing only from the subject line
    // still means the message is not ready.
    missing: [...new Set([...body.missing, ...(subject?.missing ?? [])])],
    language,
  }
}

/// A template's saved versions, newest first (R-264). Kept out of
/// TEMPLATE_SELECT, which the picker and the send path also read.
export async function listTemplateVersions(templateId: string) {
  return prisma.messageTemplateVersion.findMany({
    where: { templateId },
    orderBy: { version: 'desc' },
    select: {
      id: true,
      version: true,
      name: true,
      kind: true,
      subject: true,
      body: true,
      restoredFromVersion: true,
      createdAt: true,
      savedBy: { select: { name: true } },
    },
  })
}

/**
 * The body of a staff message to a tenant (OQ-15, R-267, D-404).
 *
 * A holder of `message.send_freeform` over the property writes their own
 * words. Anybody else picks a managed template, rendered here for this tenant
 * through `renderForRecipient` - the same path an announcement takes - so the
 * typed `body` is ignored rather than trusted: a crafted post cannot smuggle
 * free text past the picker. Returns a sentence to show instead of a body
 * when the message cannot go.
 */
export async function staffMessageBody(
  formData: FormData,
  property: { id: string; legalEntityId: string; orgId: string },
  tenantId: string | null,
): Promise<{ body: string } | { error: string }> {
  if (await actorCan('message.send_freeform', propertyResource(property))) {
    const body = formData.get('body')
    return { body: typeof body === 'string' ? body.trim() : '' }
  }

  const templateId = formData.get('templateId')
  if (typeof templateId !== 'string' || !templateId) {
    return { error: 'Choose a template to send.' }
  }
  const template = await getTemplate(templateId, property.orgId)
  if (!template?.active) return { error: 'That template is no longer available.' }

  // The tenant's newest tenancy AT THIS PROPERTY: the merge fields (rent,
  // balance, address) belong to the lease, not to the person.
  const leaseTenant = tenantId
    ? await prisma.leaseTenant.findFirst({
        where: { tenantId, orgId: property.orgId, lease: { propertyId: property.id } },
        orderBy: { lease: { startsOn: 'desc' } },
        select: {
          leaseId: true,
          tenant: {
            select: { firstName: true, lastName: true, email: true, phone: true, preferredLocale: true },
          },
        },
      })
    : null
  if (!leaseTenant) {
    return { error: 'Templates fill in from a tenancy, and this conversation has none to fill them from.' }
  }

  const { tenant } = leaseTenant
  const rendered = await renderForRecipient(template, {
    leaseId: leaseTenant.leaseId,
    tenantId,
    tenantName: `${tenant.firstName} ${tenant.lastName}`,
    preferredLocale: tenant.preferredLocale,
    email: tenant.email,
    phone: tenant.phone,
  })
  if (!rendered) return { error: 'That template could not be filled in for this tenant.' }
  if (rendered.missing.length > 0) {
    return { error: `That template needs ${rendered.missing.join(', ')}, which this tenancy has no value for.` }
  }
  return { body: rendered.body }
}
