import Link from 'next/link'
import { AGING_BUCKETS, BUCKET_LABELS } from '@rental/core/ledger'
import { formatCents } from '@rental/core/money'
import { RentRollTable } from '@/components/money/rent-roll-table.tsx'
import { propertyScope, scopeIsEmpty } from '@rental/core/rbac'
import { requireScope } from '@/lib/auth/guard.ts'
import { listTemplates } from '@/lib/comms/templates.ts'
import { rentRoll } from '@/lib/payments/rent-roll.ts'
import { sendReminders } from '@/lib/payments/reminders.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Rent roll — Rental Operations' }

// The Monday-morning report (PAY-06, RPT-02, R-044).
//
// NO `loading.tsx` HERE OR ABOVE (R-099) — the money section's pages call
// notFound() for records outside scope and a Suspense boundary above would
// stream a 200 before they ran.

export default async function RentRollPage() {
  // `requireScope`, NOT a bare `requirePermission('ledger.read')`. A
  // property-scoped manager holds ledger.read over their own properties and
  // nowhere else, and a resource-less check denies them outright — the same
  // trap the messages inbox documents, and the rent roll is exactly the same
  // shape: a list filtered to what you may see, not a single record.
  const { actor } = await requireScope('ledger.read')
  const scope = await currentScope(actor)

  // SCOPED, for the same reason the guard above is. `actorCan('message.send')`
  // with no resource asks "may you message everywhere", which a
  // property-scoped manager cannot answer yes to — and the chase controls
  // then silently vanish for exactly the person whose job this screen is.
  const canSend = !scopeIsEmpty(propertyScope(actor, 'message.send'))

  const [roll, templates] = await Promise.all([rentRoll(scope), listTemplates()])

  const unknownGrace = roll.rows.filter((row) => row.graceUnknown).length

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/money"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Money
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Rent roll</h1>
        <p className="text-muted-foreground text-sm">
          Every live tenancy: what is billed, what is owed, how long it has
          been owed, and when the tenant was last contacted.
        </p>
      </header>

      <section aria-labelledby="aging" className="flex flex-col gap-3">
        <h2 id="aging" className="text-lg font-semibold">
          Delinquency aging
        </h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {AGING_BUCKETS.map((bucket) => {
            const total = roll.totals[bucket]
            return (
              <div key={bucket} className="flex flex-col gap-1 rounded-lg border p-3">
                <dt className="text-muted-foreground text-xs font-medium">
                  {BUCKET_LABELS[bucket]}
                </dt>
                <dd className="text-xl font-semibold tabular-nums">
                  {formatCents(Math.max(0, total.balanceCents))}
                </dd>
                <dd className="text-muted-foreground text-xs">
                  {/* Every bucket renders even at zero, so "nothing over 30
                      days" is distinguishable from "we stopped counting". */}
                  {total.count} {total.count === 1 ? 'tenancy' : 'tenancies'}
                </dd>
              </div>
            )
          })}
        </dl>
        <p className="text-muted-foreground text-sm">
          {formatCents(roll.outstandingCents)} outstanding against{' '}
          {formatCents(roll.billedCents)} of monthly rent.
        </p>
        {unknownGrace > 0 && (
          // NOT SILENTLY TREATED AS ZERO GRACE (D-4). A state nobody has
          // configured is a real gap, and these tenancies can never be
          // selected for a chase until somebody closes it.
          <p className="rounded-md border border-amber-300 px-3 py-2 text-sm dark:border-amber-900">
            {unknownGrace} {unknownGrace === 1 ? 'tenancy is' : 'tenancies are'} at a
            property whose state has no jurisdiction rule configured, so
            whether they are past grace is unknown and they cannot be chased
            from here.{' '}
            <Link href="/jurisdiction" className="underline underline-offset-2">
              Configure the rules
            </Link>
            .
          </p>
        )}
      </section>

      <div className="flex items-center gap-3">
        {/* A real link, not a button with a handler: the response IS a file,
            and `onClick` is inert until hydration. */}
        <a
          href="/api/reports/rent-roll"
          className="border-input focus-visible:ring-ring min-h-11 rounded-md border px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
        >
          Export CSV
        </a>
        {templates.length === 0 && canSend && (
          <Link
            href="/messages/templates/new"
            className="text-sm underline underline-offset-4"
          >
            Write a reminder template
          </Link>
        )}
      </div>

      {roll.rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No live tenancies for the properties you can see.
        </p>
      ) : (
        <RentRollTable
          rows={roll.rows}
          templates={templates.map((template) => ({ id: template.id, name: template.name }))}
          canSend={canSend}
          // Not bound — `sendReminders` takes only (state, formData). Passed
          // as the `'use server'` export it is, which is the only kind of
          // function the client can call back to.
          sendAction={sendReminders}
        />
      )}
    </div>
  )
}
