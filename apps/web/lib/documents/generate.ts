'use server'

import { createHash } from 'node:crypto'
import {
  documentTemplateBlocks,
  renderTemplate,
  type DocumentTypeValue,
} from '@rental/core/documents'
import { businessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { renderBlocksPdf } from '@/lib/pdf/render.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'

// Generating a document from a template (DOC-04, R-062).
//
// FAILS LOUDLY ON A MISSING FIELD - the backlog's own words. `renderTemplate()`
// never substitutes a blank; a field with nothing to fill it is named in
// `missing[]`, and this action refuses to produce a PDF at all rather than
// archive a letter that says "Dear ,". The same refusal
// `announcement-actions.ts`/`payments/reminders.ts` already give a message
// template with an unresolved field - see `renderTemplate`'s own header.

export interface GenerateFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
  documentId?: string
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

export async function generateDocumentFromTemplate(
  templateId: string,
  _previous: GenerateFormState,
  formData: FormData,
): Promise<GenerateFormState> {
  const propertyId = str(formData, 'propertyId')
  const recipientName = str(formData, 'recipientName')
  if (!propertyId) return { error: 'Choose a property.', fieldErrors: { propertyId: 'Required.' } }
  if (!recipientName) {
    return { error: 'Who is this for?', fieldErrors: { recipientName: 'Required.' } }
  }

  const property = await prisma.property.findUniqueOrThrow({
    where: { id: propertyId },
    include: { legalEntity: { select: { name: true } } },
  })
  const actor = await requirePermission('document.write', propertyResource(property))
  // requirePermission()'s Actor carries an id, not a display name - fetched
  // separately for the `staff.name` merge field.
  const staff = await prisma.staffUser.findUniqueOrThrow({
    where: { id: actor.id },
    select: { name: true },
  })

  const template = await prisma.documentTemplate.findUnique({ where: { id: templateId } })
  if (!template) return { error: 'That template no longer exists.' }
  if (!template.active) return { error: 'This template has been retired.' }

  const generatedOn = businessDate(new Date(), property.timezone)
  const values: Record<string, string> = {
    'recipient.name': recipientName,
    'property.name': property.name,
    'property.address': property.addressLine1,
    'entity.name': property.legalEntity.name,
    today: generatedOn,
    'staff.name': staff.name,
  }

  const rendered = renderTemplate(template.body, values)
  if (rendered.missing.length > 0) {
    return {
      error: `Nothing to put in: ${rendered.missing.map((k) => `{{${k}}}`).join(', ')}.`,
    }
  }

  const blocks = documentTemplateBlocks({
    templateName: template.name,
    documentType: template.documentType as DocumentTypeValue,
    recipientName,
    propertyName: property.name,
    bodyText: rendered.text,
    generatedOn,
  })

  const bytes = await renderBlocksPdf(blocks, { title: `${template.name} — ${property.name}` })
  const buffer = Buffer.from(bytes)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const fileName = `${template.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${generatedOn}.pdf`
  const storageKey = generateStorageKey(propertyId, fileName)
  // Stored before the row, the same order every other archiver here uses:
  // an orphaned object costs disk, an orphaned row costs a document nobody
  // can open.
  await storage.put(storageKey, buffer, 'application/pdf')

  const document = await prisma.$transaction(async (tx) => {
    const created = await tx.document.create({
      data: {
        propertyId,
        type: template.documentType,
        fileName,
        contentType: 'application/pdf',
        sizeBytes: buffer.byteLength,
        storageKey,
        sha256,
        uploadedByStaffId: actor.id,
      },
    })
    await audit(
      {
        action: 'document.generated',
        entityType: 'Document',
        entityId: created.id,
        propertyId,
        after: {
          templateId,
          documentType: template.documentType,
          recipientName,
          sha256,
          sizeBytes: buffer.byteLength,
        },
      },
      tx,
    )
    return created
  })

  revalidatePath(`/documents/templates/${templateId}`)
  return { notice: 'Generated and archived.', documentId: document.id }
}
