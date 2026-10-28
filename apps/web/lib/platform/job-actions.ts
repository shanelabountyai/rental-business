'use server'

import { recordAudit } from '@rental/core/audit'
import { prisma } from '@rental/db'
import { headers } from 'next/headers'
import type { CronChild } from '@/lib/cron/org-health.ts'
import { requirePlatform } from '@/lib/platform/guard.ts'

// "Re-run" on `/platform/jobs` (PRD 11 §4.10, R-303b, D-356): the same request
// Vercel Cron makes for one org, so the child's own claim decides what happens
// - a no-op when today's daily run already succeeded, a retry when it failed
// or was abandoned. Never a `JobRun` re-run: that reads and writes the org's
// rows, which D-320 forbids without a grant.
//
// Only the HTTP status and the claim are read back. The child's body can carry
// an exception message, which is free text that can name a tenant (D-354);
// what the run did shows when `OrgHealth` next updates.

export interface RerunState {
  error?: string
  notice?: string
}

const CHILD_PATHS: Record<CronChild, string> = {
  daily: '/api/cron',
  notifications: '/api/cron/notifications',
  escalations: '/api/cron/escalations',
}

const isChild = (value: string): value is CronChild => Object.hasOwn(CHILD_PATHS, value)

export async function rerunCronChild(_previous: RerunState, formData: FormData): Promise<RerunState> {
  const admin = await requirePlatform({ permission: 'job.rerun', next: '/platform/jobs' })
  const orgId = String(formData.get('orgId') ?? '')
  const child = String(formData.get('child') ?? '')
  if (!isChild(child)) return { error: 'That is not a cron job.' }
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } })
  if (!org) return { error: 'That organisation no longer exists.' }

  const base = process.env.AUTH_URL
  const secret = process.env.CRON_SECRET
  if (!base || !secret) return { error: 'AUTH_URL and CRON_SECRET must both be set to re-run a job.' }

  // Recorded before the request: the act is the re-trigger, whatever it does.
  await recordAudit(prisma, {
    actor: {
      type: 'PLATFORM',
      ref: admin.id,
      ipAddress: (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown',
    },
    action: 'job.child_retriggered',
    entityType: 'Organization',
    entityId: org.id,
    orgId: org.id,
    after: { child },
  })

  const url = new URL(CHILD_PATHS[child], base)
  url.searchParams.set('org', org.id)
  let response: Response
  try {
    response = await fetch(url, { headers: { authorization: `Bearer ${secret}` }, cache: 'no-store' })
  } catch {
    return { error: 'The job could not be reached. Nothing ran.' }
  }
  const body = (await response.json().catch(() => null)) as { ok?: unknown; claim?: unknown } | null
  if (body?.claim === 'already_ran') return { notice: 'Already succeeded today, so nothing ran again.' }
  return response.ok && body?.ok === true
    ? { notice: 'The job ran and succeeded.' }
    : { error: `The job ran and failed (HTTP ${response.status}). The org’s own jobs page has the detail, behind a grant.` }
}
