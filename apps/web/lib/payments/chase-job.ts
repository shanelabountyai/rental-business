import 'server-only'

import { CHASE_LADDER_DAYS, CHASE_RUNG_LABELS, chaseRungDue } from '@rental/core/ledger'
import { formatCents } from '@rental/core/money'
import { prisma } from '@rental/db'
import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'
import { rentRoll } from '@/lib/payments/rent-roll.ts'
import { createTask } from '@/lib/tasks/create.ts'

// The delinquency ladder (PAY-06, PAY-07; R-179, review finding 11).
//
// ==========================================================================
// BEFORE THIS, NOBODY WAS CHASED UNLESS SOMEBODY REMEMBERED.
//
// The rent roll has always had the button. There was no `SCHEDULED_JOBS`
// entry for delinquency at all, so whether a tenant three weeks in arrears
// heard anything depended entirely on a human opening a screen on a Monday.
// A portfolio's collections cannot rest on that, and the failure is silent
// in the worst way: nothing is ever wrong on the screen, the money simply
// does not come in and nobody can say when we last asked for it.
//
// IT RAISES A TASK. IT DOES NOT SEND (D-9).
//
// The obvious build is an auto-send at day N. It is the wrong one, and not
// only for taste: this is a debt communication to a residential consumer,
// the copy is an operator-managed template that changes without review, and
// the tenancy may be under a protection placed five minutes ago. `notify()`
// honours holds and consent, but the DECISION to chase somebody is exactly
// the deliberate press D-9 keeps in the queue — a Task points a person at
// the rent roll with the tenancy already named, and they press the button
// this product has had all along.
//
// COUNTED FROM THE END OF GRACE, never from the due date — see
// `CHASE_LADDER_DAYS`. And EXACTLY ON the rung day, never at-or-past: a
// `>=` here would raise a task every single day a balance stayed unpaid,
// which is not a ladder, it is a queue nobody can clear.
// ==========================================================================
//
// 08:00 local, after the 06:00 late-fee assessment and the 06:00 plan check.
// Ordering is not incidental: a fee assessed this morning is part of the
// balance the task quotes, and a plan that broke overnight has already had
// its hold lifted, so a tenancy that stopped paying is chaseable on the same
// morning rather than a day later.
const LOCAL_HOUR = 8

SCHEDULED_JOBS.push({
  type: 'payments.chase',
  localHour: LOCAL_HOUR,
  description:
    'Raises a Task at each rung of the chase ladder — counted from the end of the statutory grace period, never from the due date (D-4, D-9).',
  run: async ({ propertyId, businessDate: today, now }) => {
    // THE SCREEN'S OWN ARITHMETIC, not a second copy of it. Grace resolution,
    // the R-118 balance anchor, `halt_dunning` holds and live payment plans
    // are all decided in one place, and a job that re-derived any of them
    // would be the fair-housing defect this module's own header warns about
    // wearing a cron's clothes.
    const roll = await rentRoll({ propertyIds: [propertyId] }, now)

    let flagged = 0
    for (const row of roll.rows) {
      // A hold carrying `halt_dunning` (R-084): a bankruptcy stay, a
      // disputed balance, a payment plan that is holding. The debt is still
      // owed and still aged; what stops is the asking, and a Task telling
      // somebody to ask is the asking.
      if (row.chaseHeld) continue
      // Both predicates, deliberately. `chaseRungDue` cannot return a rung
      // for a tenancy inside grace, so this is redundant — and it stays,
      // because if the two ever disagree the conservative one must win.
      if (!row.pastGrace) continue

      const rung = chaseRungDue(row.daysLate, row.graceDays)
      if (rung == null) continue

      const { created } = await createTask(prisma, {
        propertyId,
        type: 'rent.chase',
        subjectType: 'Lease',
        subjectId: row.leaseId,
        businessDate: today,
        // The LAST rung, read off the ladder rather than written as a
        // number: adding a fourth rung must not silently demote the final
        // chase back to routine. It is the one that usually precedes a
        // notice, and the window to act on it is short.
        priority: rung === CHASE_LADDER_DAYS[CHASE_LADDER_DAYS.length - 1] ? 'URGENT' : 'ROUTINE',
        title: `Chase rent — ${row.unitName}, ${formatCents(row.balanceCents)} owed, ${CHASE_RUNG_LABELS[rung]}`,
      })
      if (created) flagged++
    }

    return { checked: roll.rows.length, flagged }
  },
})
