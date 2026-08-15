import 'server-only'

import { languageFor, renderTemplate } from '@rental/core/comms'
import type { TemplateKind } from '@rental/core/comms'
import { prisma } from '@rental/db'
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

export async function listTemplates(includeRetired = false) {
  return prisma.messageTemplate.findMany({
    where: includeRetired ? {} : { active: true },
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    select: TEMPLATE_SELECT,
  })
}

export async function getTemplate(id: string) {
  return prisma.messageTemplate.findUnique({ where: { id }, select: TEMPLATE_SELECT })
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
