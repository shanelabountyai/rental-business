import 'server-only'

import { PERIODIC_TYPES, nextPeriodicDueDate, type PeriodicTypeValue } from '@rental/core/inspections'
import {
  businessDateToUtc,
  friendlyBusinessDate,
  utcToBusinessDate,
} from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'
import { createTask } from '@/lib/tasks/create.ts'

// "As a PM, I schedule periodic inspections (annual interior, seasonal
// exterior, drive-bys) using the same checklist machinery, generating tasks
// ... over time" (INSP-04, R-073) - the auto-scheduled half. A PM has been
// able to start a PERIODIC/SEASONAL/DRIVE_BY inspection by hand since R-068
// shipped those types; this is what puts one on the calendar without
// someone remembering to.
//
// PULL, NOT PUSH, like pre-move-out-scheduling-job.ts: no event makes a
// unit "due" - only the calendar does, so this re-checks every
// property-local day.
//
// A type is only ever scheduled once a PM designates a checklist as its
// default (InspectionTemplate.defaultForType) - the same "nothing on file,
// so nothing happens" posture pre-move-out-scheduling-job.ts takes for a
// jurisdiction rule nobody has reviewed yet.
const LOCAL_HOUR = 5

const TYPE_LABEL: Record<PeriodicTypeValue, string> = {
  PERIODIC: 'Periodic',
  SEASONAL: 'Seasonal',
  DRIVE_BY: 'Drive-by',
}

SCHEDULED_JOBS.push({
  type: 'inspection.periodic_scheduled',
  localHour: LOCAL_HOUR,
  description:
    "Auto-schedules the next periodic/seasonal/drive-by inspection for every unit past due, copied from whichever checklist a PM designated as that type's default (INSP-04).",
  run: async ({ propertyId, businessDate: today }) => {
    let checked = 0
    let scheduled = 0

    for (const type of PERIODIC_TYPES) {
      const template = await prisma.inspectionTemplate.findFirst({
        where: { defaultForType: type, active: true },
      })
      if (!template) continue

      const units = await prisma.unit.findMany({
        where: {
          propertyId,
          // Never more than one open cycle per type per unit - a unit whose
          // last PERIODIC inspection is still unperformed does not get a
          // second one queued behind it.
          inspections: { none: { type, performedAt: null } },
        },
        select: {
          id: true,
          name: true,
          inspections: {
            where: { type, performedAt: { not: null } },
            orderBy: { performedAt: 'desc' },
            take: 1,
            select: { performedAt: true },
          },
        },
      })
      checked += units.length

      for (const unit of units) {
        const lastPerformed = unit.inspections[0]?.performedAt
        // Never inspected under this clock before: due now, not a year from
        // whenever the unit row happened to be created - the system has no
        // real evidence of when, or whether, one last happened.
        const dueDate = lastPerformed ? nextPeriodicDueDate(utcToBusinessDate(lastPerformed), type) : today
        if (dueDate > today) continue

        const checklist = template.items as { room: string; item: string }[]

        await prisma.$transaction(async (tx) => {
          const created = await tx.inspection.create({
            data: {
              propertyId,
              unitId: unit.id,
              type,
              templateId: template.id,
              scheduledFor: businessDateToUtc(dueDate),
              items: {
                create: checklist.map((row, index) => ({ room: row.room, item: row.item, order: index })),
              },
            },
          })
          await auditAsSystem(
            'inspection.periodic_scheduled',
            {
              action: 'inspection.created',
              entityType: 'Inspection',
              entityId: created.id,
              propertyId,
              after: { type, scheduledFor: dueDate, templateId: template.id, itemCount: checklist.length },
            },
            tx,
          )
          await createTask(tx, {
            propertyId,
            type: `inspection.${type.toLowerCase()}_scheduled`,
            subjectType: 'Unit',
            subjectId: unit.id,
            businessDate: today,
            priority: 'ROUTINE',
            title: `${TYPE_LABEL[type]} inspection due ${friendlyBusinessDate(dueDate)} — ${unit.name}`,
          })
        })
        scheduled++
      }
    }

    return { checked, scheduled }
  },
})
