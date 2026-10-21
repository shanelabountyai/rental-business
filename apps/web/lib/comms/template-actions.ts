'use server'

import { TEMPLATE_KINDS, validateTemplate } from '@rental/core/comms'
import type { TemplateKind } from '@rental/core/comms'
import { prisma } from '@rental/db'
import type { Prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { requirePermission } from '@/lib/auth/guard.ts'

// Writing managed templates (COMM-03, R-049).
//
// PORTFOLIO-WIDE PERMISSIONS, WITH NO RESOURCE, and that is correct here
// rather than the mistake it usually is. A template is not owned by a
// property — the same violation notice is sent from all of them — so there is
// no scoped resource to check against, exactly as R-010's jurisdiction rules
// have none. See propertyResource()'s own comment for the failure mode a
// resource-less check normally is.

export interface TemplateFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

interface TemplateContent {
  name: string
  kind: string
  subject: string | null
  body: string
}

/// Appends the template's new state to its history (R-264). Call it AFTER the
/// template row is written in the same transaction: that write holds the row
/// lock, so a concurrent save waits here and then reads the number this one
/// took. The unique key is the backstop if it ever does not.
async function recordVersion(
  tx: Prisma.TransactionClient,
  templateId: string,
  content: TemplateContent,
  staffId: string,
  restoredFromVersion: number | null = null,
): Promise<number> {
  const latest = await tx.messageTemplateVersion.findFirst({
    where: { templateId },
    orderBy: { version: 'desc' },
    select: { version: true },
  })
  const version = (latest?.version ?? 0) + 1
  await tx.messageTemplateVersion.create({
    data: { templateId, version, ...content, savedByStaffId: staffId, restoredFromVersion },
  })
  return version
}

function sameContent(a: TemplateContent, b: TemplateContent): boolean {
  return a.name === b.name && a.kind === b.kind && a.subject === b.subject && a.body === b.body
}

export async function saveTemplate(
  templateId: string | null,
  _previous: TemplateFormState,
  formData: FormData,
): Promise<TemplateFormState> {
  const actor = await requirePermission('template.write')

  const kindRaw = str(formData, 'kind')
  if (!TEMPLATE_KINDS.includes(kindRaw as TemplateKind)) {
    return { error: 'Choose whether this is a routine message or a legal notice.' }
  }
  const kind = kindRaw as TemplateKind

  const input = {
    name: str(formData, 'name'),
    kind,
    subject: str(formData, 'subject') || null,
    body: str(formData, 'body'),
  }

  // VALIDATED HERE BECAUSE THIS IS THE LAST MOMENT A HUMAN IS PRESENT. Every
  // later checkpoint is either optional (preview) or automated (send), and a
  // typo'd merge field that reaches the send path goes out wrong to everybody
  // at once rather than to one person.
  const violations = validateTemplate(input)
  if (violations.length > 0) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }

  const existing = templateId
    ? await prisma.messageTemplate.findUnique({
        where: { id: templateId },
        select: { name: true, kind: true, subject: true, body: true },
      })
    : null
  if (templateId && !existing) return { error: 'That template no longer exists.' }

  let savedId = templateId
  await prisma.$transaction(async (tx) => {
    const saved = templateId
      ? await tx.messageTemplate.update({
          where: { id: templateId },
          data: { ...input, updatedByStaffId: actor.id },
        })
      : await tx.messageTemplate.create({
          data: { ...input, createdByStaffId: actor.id },
        })
    savedId = saved.id
    // A save that changed nothing is not a version. Otherwise pressing Save
    // twice buries the real history under identical rows.
    if (!existing || !sameContent(existing, input)) {
      await recordVersion(tx, saved.id, input, actor.id)
    }

    await audit(
      {
        action: 'template.saved',
        entityType: 'MessageTemplate',
        entityId: saved.id,
        // BOTH SNAPSHOTS, because a template is edited in place and a message
        // sent from it is evidence. "What did this template say on the day it
        // went out" is otherwise unanswerable from a row somebody has since
        // reworded.
        before: existing ?? undefined,
        after: input,
      },
      tx,
    )
  })

  revalidatePath('/messages/templates')
  if (!templateId) redirect(`/messages/templates/${savedId}`)
  return { notice: 'Saved.' }
}

/**
 * Puts an older version's words back (R-264). NOT A REWIND: the restore is a
 * new version that copies the old one, so the history still shows what was
 * live in between, and who brought the old words back.
 */
export async function restoreTemplateVersion(
  templateId: string,
  _previous: TemplateFormState,
  formData: FormData,
): Promise<TemplateFormState> {
  const actor = await requirePermission('template.write')
  const versionId = str(formData, 'versionId')

  const [current, old] = await Promise.all([
    prisma.messageTemplate.findUnique({
      where: { id: templateId },
      select: { name: true, kind: true, subject: true, body: true },
    }),
    prisma.messageTemplateVersion.findFirst({
      where: { id: versionId, templateId },
      select: { version: true, name: true, kind: true, subject: true, body: true },
    }),
  ])
  if (!current || !old) return { error: 'That version no longer exists.' }

  const content: TemplateContent = { name: old.name, kind: old.kind, subject: old.subject, body: old.body }
  if (sameContent(current, content)) return { notice: 'That is already what the template says.' }

  // RE-VALIDATED, because the merge-field catalogue can have moved since the
  // old version was written. Restoring words that name a field that no longer
  // exists would put a broken template back in the picker.
  const violations = validateTemplate({ ...content, kind: content.kind as TemplateKind })
  if (violations.length > 0) {
    return {
      error: `Version ${old.version} cannot be restored as it stands: ${violations.map((v) => v.message).join(' ')}`,
    }
  }

  let version = 0
  await prisma.$transaction(async (tx) => {
    await tx.messageTemplate.update({
      where: { id: templateId },
      data: { ...content, updatedByStaffId: actor.id },
    })
    version = await recordVersion(tx, templateId, content, actor.id, old.version)
    await audit(
      {
        action: 'template.restored',
        entityType: 'MessageTemplate',
        entityId: templateId,
        before: current,
        after: { ...content, restoredFromVersion: old.version },
      },
      tx,
    )
  })

  revalidatePath('/messages/templates')
  revalidatePath(`/messages/templates/${templateId}`)
  return { notice: `Restored version ${old.version} as version ${version}.` }
}

/**
 * Copies a template into a new one to edit (R-264). Translations come along
 * UNAPPROVED: an approval vouches for one template's legal wording, and the
 * copy exists to be reworded.
 */
export async function duplicateTemplate(
  templateId: string,
  _previous: TemplateFormState,
  _formData: FormData,
): Promise<TemplateFormState> {
  const actor = await requirePermission('template.write')

  const source = await prisma.messageTemplate.findUnique({
    where: { id: templateId },
    select: {
      name: true,
      kind: true,
      subject: true,
      body: true,
      translations: { select: { locale: true, subject: true, body: true } },
    },
  })
  if (!source) return { error: 'That template no longer exists.' }

  const content: TemplateContent = {
    name: `Copy of ${source.name}`,
    kind: source.kind,
    subject: source.subject,
    body: source.body,
  }

  let copyId = ''
  await prisma.$transaction(async (tx) => {
    const copy = await tx.messageTemplate.create({
      data: {
        ...content,
        createdByStaffId: actor.id,
        translations: { create: source.translations },
      },
    })
    copyId = copy.id
    await recordVersion(tx, copy.id, content, actor.id)
    await audit(
      {
        action: 'template.saved',
        entityType: 'MessageTemplate',
        entityId: copy.id,
        after: { ...content, duplicatedFrom: templateId },
      },
      tx,
    )
  })

  revalidatePath('/messages/templates')
  redirect(`/messages/templates/${copyId}`)
}

export async function retireTemplate(
  templateId: string,
  _previous: TemplateFormState,
  _formData: FormData,
): Promise<TemplateFormState> {
  const actor = await requirePermission('template.write')

  const existing = await prisma.messageTemplate.findUnique({
    where: { id: templateId },
    select: { active: true, name: true },
  })
  if (!existing) return { error: 'That template no longer exists.' }

  await prisma.$transaction(async (tx) => {
    await tx.messageTemplate.update({
      where: { id: templateId },
      // RETIRED, NOT DELETED. A message sent from a template is evidence, and
      // the template it came from is part of explaining it.
      data: { active: !existing.active, updatedByStaffId: actor.id },
    })
    await audit(
      {
        action: 'template.saved',
        entityType: 'MessageTemplate',
        entityId: templateId,
        before: { active: existing.active },
        after: { active: !existing.active },
      },
      tx,
    )
  })

  revalidatePath('/messages/templates')
  revalidatePath(`/messages/templates/${templateId}`)
  return { notice: existing.active ? 'Retired.' : 'Back in use.' }
}

export async function saveTranslation(
  templateId: string,
  _previous: TemplateFormState,
  formData: FormData,
): Promise<TemplateFormState> {
  await requirePermission('template.write')

  const locale = str(formData, 'locale').toLowerCase()
  const body = str(formData, 'body')
  if (!locale) return { error: 'Which language is this?', fieldErrors: { locale: 'Required.' } }
  if (!body) return { error: 'A translation needs a body.', fieldErrors: { body: 'Required.' } }

  const template = await prisma.messageTemplate.findUnique({
    where: { id: templateId },
    select: { kind: true },
  })
  if (!template) return { error: 'That template no longer exists.' }

  // MERGE FIELDS ARE VALIDATED IN THE TRANSLATION TOO. A translator who
  // renders `{{tenant.first_name}}` as `{{nombre}}` has produced a message
  // that will go out with a visible token in it, and the translation is
  // exactly where nobody would think to look.
  const violations = validateTemplate({
    name: 'translation',
    kind: template.kind as TemplateKind,
    subject: str(formData, 'subject') || null,
    body,
  })
  const fieldViolations = violations.filter((v) => v.field !== 'name')
  if (fieldViolations.length > 0) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: Object.fromEntries(fieldViolations.map((v) => [v.field, v.message])),
    }
  }

  await prisma.messageTemplateTranslation.upsert({
    where: { templateId_locale: { templateId, locale } },
    // EDITING A TRANSLATION CLEARS ITS APPROVAL. Otherwise somebody approves a
    // Spanish notice, reopens it, rewrites the cure period, and the approved
    // stamp still sits there vouching for words nobody read.
    update: { subject: str(formData, 'subject') || null, body, approvedAt: null, approvedByStaffId: null },
    create: { templateId, locale, subject: str(formData, 'subject') || null, body },
  })

  revalidatePath(`/messages/templates/${templateId}`)
  return { notice: 'Translation saved. It still needs approving before it can be used for a legal notice.' }
}

/**
 * Marks a translation approved.
 *
 * ==========================================================================
 * THE MOST CONSEQUENTIAL ACTION IN THIS ITEM, and the reason
 * `template.approve` is its own privileged permission rather than part of
 * `template.write`.
 *
 * COMM-03's rule — attorney-approved translations for legal notices, machine
 * translation for routine chat only — comes down to one timestamp. If the
 * person who pasted in a machine translation can also set it, the rule is
 * decorative: they mark their own work approved and a defective notice to
 * vacate goes out in a language nobody with authority read.
 *
 * The product CANNOT verify an attorney reviewed it. It can only record who
 * claimed so and why, which is what the required reason is for.
 * ==========================================================================
 */
export async function approveTranslation(
  translationId: string,
  _previous: TemplateFormState,
  formData: FormData,
): Promise<TemplateFormState> {
  const actor = await requirePermission('template.approve')

  const reason = str(formData, 'reason')
  if (reason.length < 10) {
    return {
      error: 'Say who reviewed this and on what basis.',
      fieldErrors: {
        reason: 'This is the record that a person with authority read these words. "Reviewed by counsel, 14 Aug" — not "ok".',
      },
    }
  }

  const translation = await prisma.messageTemplateTranslation.findUnique({
    where: { id: translationId },
    select: { id: true, locale: true, templateId: true, approvedAt: true },
  })
  if (!translation) return { error: 'That translation no longer exists.' }
  if (translation.approvedAt) return { notice: 'Already approved.' }

  await prisma.$transaction(async (tx) => {
    await tx.messageTemplateTranslation.update({
      where: { id: translationId },
      data: { approvedAt: new Date(), approvedByStaffId: actor.id },
    })
    await audit(
      {
        action: 'template.translation_approved',
        entityType: 'MessageTemplateTranslation',
        entityId: translationId,
        after: { templateId: translation.templateId, locale: translation.locale },
        reason,
      },
      tx,
    )
  })

  revalidatePath(`/messages/templates/${translation.templateId}`)
  return { notice: 'Approved. It will now be used for tenants who read this language.' }
}
