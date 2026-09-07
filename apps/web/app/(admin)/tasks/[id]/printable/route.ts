import { type DocumentBlock } from '@rental/core/documents'
import { friendlyTimestamp } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { requireScope } from '@/lib/auth/guard.ts'
import { documentResponse } from '@/lib/documents/serve.ts'
import { renderBlocksPdf } from '@/lib/pdf/render.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { getTask } from '@/lib/tasks/queries.ts'

// THE PAPER END OF THE NOTIFICATION ENGINE (R-173).
//
// A `serve_notice_offline` task says a legally required notice could not be
// delivered - the recipient's carrier is blocking our texts (D-38), or we
// hold no email and no phone for them at all. Either way somebody has to walk
// to the door with a piece of paper, and until this route existed the task
// told them to do that without giving them anything to print: the notice text
// lived only in the append-only `Notification` rows the engine wrote.
//
// It renders those rows rather than re-deriving the message. What gets posted
// on the door is then byte-for-byte the notice the engine decided to send,
// which is the only version worth defending later - a second generator with
// its own copy of the template is a second thing that can drift.
//
// R-062's renderer, unmodified: tagged, `/Lang`-bearing, accessible PDF from
// typed blocks. Served through `documentResponse` because CLAUDE.md's rule is
// that no route hand-writes a byte response - even one whose bytes it made
// itself and knows are a PDF.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/// The channel whose rendering is worth printing. An SMS body is written to
/// fit 160 characters; the email and portal bodies are the whole notice, and
/// posting the truncated one on a door would be serving less than we decided
/// to serve.
const PRINT_PREFERENCE = ['EMAIL', 'PORTAL', 'SMS'] as const

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const { actor } = await requireScope('task.read')
  const scope = await currentScope(actor)

  // 404 rather than 403 for a task outside this actor's scope - `getTask`
  // already applies that rule (ROLE-01), and this route must not become the
  // one place a guessed id is confirmed.
  const task = await getTask(id, scope)
  if (!task || task.subjectType !== 'Notification') {
    return new Response('Not found', { status: 404 })
  }

  // The task's subjectId is the notification's BASE idempotency key; the
  // engine suffixes `:<CHANNEL>` per row. Scoped to the task's own property
  // as well, so a key collision could not reach across the portfolio.
  const notifications = await prisma.notification.findMany({
    where: {
      idempotencyKey: { startsWith: `${task.subjectId}:` },
      propertyId: task.propertyId,
    },
    orderBy: { createdAt: 'asc' },
  })
  if (notifications.length === 0) {
    return new Response('Not found', { status: 404 })
  }

  const notification =
    PRINT_PREFERENCE.map((channel) =>
      notifications.find((row) => row.channel === channel),
    ).find((row) => row != null) ?? notifications[0]!

  const [property, recipientName] = await Promise.all([
    prisma.property.findUniqueOrThrow({
      where: { id: task.propertyId },
      select: {
        name: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        state: true,
        postalCode: true,
        timezone: true,
      },
    }),
    nameOf(notification.recipientType, notification.recipientId),
  ])

  const address = [
    property.addressLine1,
    property.addressLine2,
    `${property.city}, ${property.state} ${property.postalCode}`,
  ]
    .filter((line) => line != null && line !== '')
    .join(', ')

  const blocks: DocumentBlock[] = [
    { kind: 'heading', text: notification.subject ?? task.title },
    { kind: 'meta', text: `For: ${recipientName}` },
    { kind: 'meta', text: `Property: ${property.name}, ${address}` },
    {
      kind: 'meta',
      text: `Prepared: ${friendlyTimestamp(notification.createdAt, property.timezone)}`,
    },
    ...notification.body
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph !== '')
      .map((text): DocumentBlock => ({ kind: 'paragraph', text })),
    {
      kind: 'footer',
      text: `Served on paper because this notice could not be delivered electronically. Record how and when it was posted against the notice itself - this page is not the record of service. Reference ${task.subjectId}.`,
    },
  ]

  const bytes = await renderBlocksPdf(blocks, {
    title: notification.subject ?? task.title,
  })

  return documentResponse(
    Buffer.from(bytes),
    { contentType: 'application/pdf', fileName: 'notice-to-post.pdf' },
    // No caching. The recipient's contact details can be filled in a minute
    // from now, and a stale copy of a legal notice sitting in a shared cache
    // is exactly the artifact this product must not produce.
    { cacheControl: 'no-store' },
  )
}

/// Who it is for, in the words a person posting it needs. Falls back to the
/// recipient type rather than failing: a printable notice with no name is
/// still the notice, and refusing to render one because a lookup missed
/// would leave the door un-served.
async function nameOf(type: string, id: string): Promise<string> {
  if (type === 'TENANT') {
    const tenant = await prisma.tenant.findUnique({
      where: { id },
      select: { firstName: true, lastName: true },
    })
    if (tenant) return `${tenant.firstName} ${tenant.lastName}`
  }
  if (type === 'GUARANTOR') {
    const guarantor = await prisma.guarantor.findUnique({
      where: { id },
      select: { firstName: true, lastName: true },
    })
    if (guarantor) return `${guarantor.firstName} ${guarantor.lastName}`
  }
  return `${type.charAt(0)}${type.slice(1).toLowerCase()} (name not on file)`
}
