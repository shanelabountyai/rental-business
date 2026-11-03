import 'server-only'

import { randomBytes } from 'node:crypto'
import { hashToken } from '@rental/core/auth'
import { type DocumentTypeValue, retentionCutoff } from '@rental/core/documents'
import { businessDateToUtc, friendlyTimestamp, utcToBusinessDate } from '@rental/core/scheduling'
import { Prisma, prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { authUrl } from '@/lib/auth/org-url.ts'
import { type OrgRunResult } from '@/lib/cron/per-org.ts'
import { ORG_EXPORT_JOB, ORG_EXPORT_TTL_MS, claimOrgExport, runOrgExport } from '@/lib/export/org-export.ts'
import { disconnectStripeForOffboarding } from '@/lib/integrations/stripe-onboarding.ts'
import { retireTwilioProvisioning } from '@/lib/integrations/twilio-provisioning.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
import { storage } from '@/lib/storage/index.ts'
import { activeOwners, orgTimezone } from '@/lib/support/grants.ts'

// The offboard run (R-300b, PRD 10 §8, D-386, D-387, D-388): the daily cron's
// branch for a FROZEN org whose `offboardAt` has passed, in this order -
//
//   1. the R-299 export, made on or after the purge day;
//   2. each owner emailed a link to it that also asks for their authenticator
//      code (D-388) - and NOTHING below runs until every one of those emails
//      has gone, because after step 4 there is no other way to reach them;
//   3. Stripe disconnected (not deleted), the Twilio subaccount closed;
//   4. contact details blanked on what stays (D-387), then every org row
//      outside the evidence closure deleted, with its files;
//   5. OFFBOARDED.
//
// EVERY STEP IS SAFE TO RUN AGAIN. A tick that dies at any point leaves the
// org FROZEN, and the next tick picks up where it stopped: the export is
// found rather than remade, a link that exists is not re-sent, a disconnected
// provider is skipped, and a purge deletes only what is still there.
//
// Then, once the links expire, `clearExpiredFinalExports` deletes the
// archive, the links and the owners' credentials, so nothing outlives them.

/// D-319: the tables the database refuses to change. Everything they reach by
/// FK - and everything THOSE rows reach - stays until Milestone 20's archive.
const APPEND_ONLY = ['LedgerEntry', 'AuditLog', 'Message', 'Notification']
/// Kept whole: the org's own row and the records of its offboarding. None
/// holds a person's details (OrgIntegration's secrets are gone by step 3).
const KEPT_WHOLE = new Set(['Organization', 'OrgIntegration', 'OrgHealth', 'JobRun', 'FinalExportLink'])

type Model = (typeof Prisma.dmmf.datamodel.models)[number]
const MODELS = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]))

type Delegate = {
  findMany(args: object): Promise<Record<string, unknown>[]>
  deleteMany(args: object): Promise<{ count: number }>
}
function delegate(model: string): Delegate {
  return (prisma as unknown as Record<string, Delegate>)[model[0]!.toLowerCase() + model.slice(1)]!
}

/// model -> referenced field -> the values some kept row points at.
export type EvidenceClosure = Map<string, Map<string, Set<unknown>>>

/**
 * What the purge may not touch, READ FROM THE SCHEMA like the export's table
 * list: start at the org's append-only rows and its Documents still inside
 * their retention window (`retentionCutoff`), and follow every FK outward
 * until nothing new turns up. A table added next month is walked without
 * anyone remembering this file. (No relation in the schema spans two
 * columns; one that did would need a tuple here.)
 */
export async function evidenceClosure(orgId: string, now = new Date()): Promise<EvidenceClosure> {
  const kept: EvidenceClosure = new Map()
  const add = (model: string, field: string, values: unknown[]): unknown[] => {
    const fields = kept.get(model) ?? kept.set(model, new Map()).get(model)!
    const set = fields.get(field) ?? fields.set(field, new Set()).get(field)!
    const fresh = [...new Set(values)].filter((v) => v != null && !set.has(v))
    for (const v of fresh) set.add(v)
    return fresh
  }

  const queue: { model: string; where: object }[] = APPEND_ONLY.map((model) => ({ model, where: { orgId } }))
  const documents = await prisma.document.findMany({ where: { orgId }, select: { id: true, type: true, createdAt: true } })
  const retained = documents
    .filter((d) => {
      const cutoff = retentionCutoff(d.type as DocumentTypeValue, d.createdAt)
      return cutoff === null || cutoff > now
    })
    .map((d) => d.id)
  if (add('Document', 'id', retained).length > 0) queue.push({ model: 'Document', where: { id: { in: retained } } })

  for (let next = queue.shift(); next; next = queue.shift()) {
    const relations = MODELS.get(next.model)!.fields.filter((f) => f.relationFromFields?.length)
    if (relations.length === 0) continue
    const select = Object.fromEntries(relations.map((f) => [f.relationFromFields![0], true]))
    const rows = await delegate(next.model).findMany({ where: next.where, select })
    for (const relation of relations) {
      const from = relation.relationFromFields![0]!
      const to = relation.relationToFields![0]!
      const fresh = add(relation.type, to, rows.map((r) => r[from]))
      if (fresh.length > 0) queue.push({ model: relation.type, where: { [to]: { in: fresh } } })
    }
  }
  return kept
}

function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2003'
}

/**
 * Deletes every org-scoped row the closure does not hold. Delete order is
 * found rather than declared: a table a surviving child still points at
 * refuses (P2003) and is retried after the others, until a pass deletes
 * nothing new - then it throws naming the tables, and the org stays FROZEN.
 */
export async function purgeOutsideEvidence(orgId: string, kept: EvidenceClosure): Promise<Record<string, number>> {
  let pending: Model[] = [...MODELS.values()].filter(
    (m) => m.fields.some((f) => f.name === 'orgId') && !APPEND_ONLY.includes(m.name) && !KEPT_WHOLE.has(m.name),
  )
  const removed: Record<string, number> = {}
  while (pending.length > 0) {
    const blocked: Model[] = []
    for (const model of pending) {
      const keep = [...(kept.get(model.name) ?? new Map<string, Set<unknown>>())].map(([field, values]) => ({
        [field]: { in: [...values] },
      }))
      try {
        const { count } = await delegate(model.name).deleteMany({ where: { orgId, ...(keep.length > 0 && { NOT: { OR: keep } }) } })
        if (count > 0) removed[model.name] = (removed[model.name] ?? 0) + count
      } catch (error) {
        if (!isForeignKeyViolation(error)) throw error
        blocked.push(model)
      }
    }
    if (blocked.length === pending.length) {
      throw new Error(`The purge is blocked by foreign keys on ${blocked.map((m) => m.name).join(', ')}.`)
    }
    pending = blocked
  }
  return removed
}

/**
 * D-387: what stays for evidence loses the person. Every Tenant, Guarantor
 * and Vendor of the org (the ones about to be purged as well - cheaper than
 * asking which), and every member who belongs to no other org live. Ids are
 * untouched, so the evidence still joins up. Sessions end with it.
 */
async function blankContactDetails(orgId: string, now: Date): Promise<string[]> {
  await prisma.tenant.updateMany({
    where: { orgId },
    data: { firstName: 'Former', lastName: 'tenant', email: null, phone: null, notes: null, sessionsValidFrom: now },
  })
  await prisma.guarantor.updateMany({
    where: { orgId },
    data: { firstName: 'Former', lastName: 'guarantor', email: null, phone: null, sessionsValidFrom: now },
  })
  await prisma.vendor.updateMany({
    where: { orgId },
    data: { name: 'Former vendor', contactName: null, email: null, phone: null, notes: null },
  })
  const staff = await prisma.staffUser.findMany({
    where: {
      orgMemberships: { some: { orgId } },
      NOT: { orgMemberships: { some: { orgId: { not: orgId }, removedAt: null } } },
    },
    select: { id: true },
  })
  // ponytail: one UPDATE per person, because the unique email has to differ;
  // fine at a small team's size.
  for (const { id } of staff) {
    await prisma.staffUser.update({
      where: { id },
      data: {
        name: 'Former staff member',
        email: `former-${id}@offboarded.invalid`,
        phone: null,
        active: false,
        deactivatedAt: now,
        onCallFrom: null,
        onCallUntil: null,
        sessionsValidFrom: now,
      },
    })
  }
  // A link holder keeps the credential its code is checked against until the
  // link expires (`clearExpiredFinalExports`); nobody else needs one.
  await prisma.staffCredential.deleteMany({
    where: { staffUserId: { in: staff.map((s) => s.id) }, staffUser: { finalExportLinks: { none: {} } } },
  })
  return staff.map((s) => s.id)
}

/// The export the owners are sent: one finished on or after the purge day
/// (the claim is per UTC day, so "today's" is always one). Made if missing.
async function finalExport(orgId: string, offboardAt: Date): Promise<{ id: string; storageKey: string } | 'running' | 'failed'> {
  const find = async () => {
    const run = await prisma.jobRun.findFirst({
      where: {
        orgId,
        jobType: ORG_EXPORT_JOB,
        status: 'SUCCEEDED',
        finishedAt: { gte: businessDateToUtc(utcToBusinessDate(offboardAt)) },
      },
      orderBy: { finishedAt: 'desc' },
      select: { id: true, result: true },
    })
    const storageKey = (run?.result as { storageKey?: string } | null)?.storageKey
    return run && storageKey ? { id: run.id, storageKey } : null
  }
  const existing = await find()
  if (existing) return existing
  const claim = await claimOrgExport(orgId)
  if (!claim.ok) return claim.reason === 'running' ? 'running' : ((await find()) ?? 'failed')
  await runOrgExport(claim.id, orgId)
  return (await find()) ?? 'failed'
}

/// Step 2. Returns how many owners' emails have not gone yet.
async function sendFinalExportLinks(orgId: string, archive: { storageKey: string }, now: Date): Promise<number> {
  const [org, owners, zone] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true } }),
    activeOwners(orgId),
    orgTimezone(orgId),
  ])
  if (owners.length === 0) throw new Error('No active owner to send the final export to.')
  const linked = new Set(
    (await prisma.finalExportLink.findMany({ where: { orgId }, select: { staffUserId: true } })).map((l) => l.staffUserId),
  )
  const expiresAt = new Date(now.getTime() + ORG_EXPORT_TTL_MS)
  for (const owner of owners.filter((o) => !linked.has(o.id))) {
    const token = randomBytes(32).toString('base64url')
    const tokenHash = hashToken(token)
    // Sent BEFORE the row: an email whose row then failed to write is a dead
    // link followed by a working one tomorrow; the other order is a live
    // link nobody was ever told about.
    await notify({
      category: 'org_status',
      templateKey: 'org.status_changed',
      recipient: { type: 'STAFF', id: owner.id, email: owner.email, phone: owner.phone },
      context: {
        orgName: org.name,
        change: 'offboarded',
        by: 'platform',
        url: await authUrl(orgId, `/final-export/${token}`),
        availableUntil: friendlyTimestamp(expiresAt, zone),
      },
      orgId,
      idempotencyKey: `final-export:${orgId}:${owner.id}:${tokenHash}`,
      now,
    })
    await prisma.finalExportLink.create({
      data: { orgId, staffUserId: owner.id, tokenHash, storageKey: archive.storageKey, expiresAt },
    })
  }
  // At once: crons skip the org, so this run is the only drain it gets.
  await dispatchPendingNotifications(now, 100, { orgId })
  return prisma.notificationDelivery.count({
    where: { notification: { orgId, idempotencyKey: { startsWith: `final-export:${orgId}:` } }, status: { not: 'SENT' } },
  })
}

export async function runOffboarding(orgId: string, now = new Date()): Promise<OrgRunResult> {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { status: true, offboardAt: true } })
  if (org.status === 'OFFBOARDED') return clearExpiredFinalExports(orgId, now)
  if (org.status !== 'FROZEN' || !org.offboardAt || org.offboardAt > now) return { ok: true, skipped: 'not_due' }

  const archive = await finalExport(orgId, org.offboardAt)
  // A running export is another tick's, not a failure; tomorrow continues.
  if (archive === 'running') return { ok: true, stage: 'export_running' }
  if (archive === 'failed') return { ok: false, stage: 'export_failed' }
  const unsent = await sendFinalExportLinks(orgId, archive, now)
  if (unsent > 0) return { ok: false, stage: 'final_export_email', unsent }

  const stripeDisconnected = await disconnectStripeForOffboarding(orgId)
  const twilioRetired = (await retireTwilioProvisioning(orgId)) !== null

  const blankedStaff = await blankContactDetails(orgId, now)
  const kept = await evidenceClosure(orgId, now)
  const keptDocuments = kept.get('Document')?.get('id') ?? new Set()
  const doomedFiles = await prisma.document.findMany({ where: { orgId }, select: { id: true, storageKey: true } })
  const removed = await purgeOutsideEvidence(orgId, kept)
  // Rows first, then bytes, so no surviving row points at a missing file. The
  // exports made during the freeze go too; only the final one stays, until
  // its links expire.
  const oldExports = await prisma.jobRun.findMany({
    where: { orgId, jobType: ORG_EXPORT_JOB, status: 'SUCCEEDED', id: { not: archive.id } },
    select: { result: true },
  })
  const files = [
    ...doomedFiles.filter((d) => !keptDocuments.has(d.id)).map((d) => d.storageKey),
    ...oldExports.map((r) => (r.result as { storageKey?: string } | null)?.storageKey).filter((k): k is string => !!k),
  ]
  for (const key of files) await storage.delete(key)

  const { count } = await prisma.organization.updateMany({ where: { id: orgId, status: 'FROZEN' }, data: { status: 'OFFBOARDED' } })
  if (count === 1) {
    await auditAsSystem('cron', {
      action: 'org.offboarded',
      entityType: 'Organization',
      entityId: orgId,
      orgId,
      before: { status: 'FROZEN' },
      after: { status: 'OFFBOARDED', removed, filesDeleted: files.length, blankedStaff: blankedStaff.length, stripeDisconnected, twilioRetired },
    })
  }
  return { ok: true, stage: 'offboarded', removed, filesDeleted: files.length }
}

/// After the links expire: the archive, the links, and the credentials the
/// links were checked against. The last thing an offboarded org held.
export async function clearExpiredFinalExports(orgId: string, now = new Date()): Promise<OrgRunResult> {
  const links = await prisma.finalExportLink.findMany({
    where: { orgId, expiresAt: { lt: now } },
    select: { id: true, staffUserId: true, storageKey: true },
  })
  if (links.length === 0) return { ok: true, skipped: 'nothing_expired' }
  for (const key of new Set(links.map((l) => l.storageKey))) await storage.delete(key)
  const staffUserIds = links.map((l) => l.staffUserId)
  await prisma.finalExportLink.deleteMany({ where: { id: { in: links.map((l) => l.id) } } })
  // Only someone no other org still has live (D-387's own test).
  await prisma.staffCredential.deleteMany({
    where: { staffUserId: { in: staffUserIds }, staffUser: { orgMemberships: { none: { removedAt: null } } } },
  })
  await auditAsSystem('cron', {
    action: 'org.final_export_cleared',
    entityType: 'Organization',
    entityId: orgId,
    orgId,
    after: { links: links.length },
  })
  return { ok: true, stage: 'final_export_cleared', links: links.length }
}

/// The orgs the daily fan-out runs `runOffboarding` for, beside the runnable ones.
export const OFFBOARD_DUE = (now: Date): Prisma.OrganizationWhereInput => ({
  OR: [
    { status: 'FROZEN', offboardAt: { lte: now } },
    { status: 'OFFBOARDED', finalExportLinks: { some: { expiresAt: { lt: now } } } },
  ],
})
