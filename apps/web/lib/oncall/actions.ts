'use server'

import { ON_CALL_SHIFT_HOURS } from '@rental/core/oncall'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { requireStaff } from '@/lib/auth/guard.ts'

// The on-call toggle (MAINT-12: "a two-person operation still needs one",
// R-029).
//
// SELF-SERVICE, AND ONLY FOR YOURSELF. There is no permission check beyond
// being signed-in staff, because putting YOURSELF on call is not a privilege -
// it is volunteering. Putting somebody ELSE on call is, and this action
// cannot do it: the row it writes is always `actor.id`. A rota screen where
// one person schedules the team is a real thing to want and it needs a real
// permission; it is not this.
//
// A WINDOW, NOT A BOOLEAN. The failure mode of a checkbox is somebody
// forgetting to clear it and being paged at 3am for a month, and the failure
// mode of that is they mute the channel. A window that lapses on its own
// fails toward "nobody is on call", which the rota already handles safely by
// paging everybody - see packages/core/oncall.
//
// TAKES FormData, so the button that calls it is a real <form> submission
// rather than an onClick handler. A handler does nothing until React has
// hydrated, and "the button did nothing" on the screen somebody opens at 3am
// on a bad connection is the failure this whole item exists to prevent.

export interface OnCallFormState {
  error?: string
}

export async function setOnCall(
  _previous: OnCallFormState,
  formData: FormData,
): Promise<OnCallFormState> {
  const actor = await requireStaff()

  const raw = String(formData.get('hours') ?? '')
  const hours = raw === 'off' ? null : Number(raw)
  if (hours !== null && !(ON_CALL_SHIFT_HOURS as readonly number[]).includes(hours)) {
    return { error: 'Choose one of the offered shift lengths.' }
  }

  const before = await prisma.staffUser.findUnique({
    where: { id: actor.id },
    select: { onCallFrom: true, onCallUntil: true },
  })

  const now = new Date()
  const data =
    hours === null
      ? { onCallFrom: null, onCallUntil: null }
      : { onCallFrom: now, onCallUntil: new Date(now.getTime() + hours * 3_600_000) }

  await prisma.$transaction(async (tx) => {
    await tx.staffUser.update({ where: { id: actor.id }, data })
    await audit(
      {
        action: 'staff.on_call_changed',
        entityType: 'StaffUser',
        entityId: actor.id,
        before: {
          onCallFrom: before?.onCallFrom?.toISOString() ?? null,
          onCallUntil: before?.onCallUntil?.toISOString() ?? null,
        },
        after: {
          onCallFrom: data.onCallFrom?.toISOString() ?? null,
          onCallUntil: data.onCallUntil?.toISOString() ?? null,
        },
      },
      tx,
    )
  })

  revalidatePath('/account')
  return {}
}
