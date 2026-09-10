import { formatCents } from '@rental/core/money'
import { friendlyBusinessDate, utcToBusinessDate } from '@rental/core/scheduling'
import { SCHEDULE_E } from '@rental/core/tax'
import { prisma } from '@rental/db'
import Link from 'next/link'
import { RecordExpenseForm } from '@/components/property-expenses/record-expense-form.tsx'
import { requireScope } from '@/lib/auth/guard.ts'
import { recordPropertyExpense, stopExpenseRecurrence } from '@/lib/property-expenses/actions.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { exportableEntities } from '@/lib/tax/queries.ts'

export const metadata = { title: 'Property expenses — Rental Operations' }

// R-193: the property tax bill, the landlord policy, the management fee -
// owner-side outlay nobody invoiced, feeding the tax export and
// `/reports/operating`.
//
// NO `loading.tsx` HERE OR ABOVE (R-099).
//
// Twenty most recently ENTERED, not most recently paid: this page records and
// confirms, and last January's tax bill typed in today is the row somebody is
// looking for. The reports are where the money is read.

const RECENT_LIMIT = 20

export default async function PropertyExpensesPage() {
  const { actor } = await requireScope('property.write')
  const scope = await currentScope(actor)

  const entities = exportableEntities(scope)
  const properties = scope.availableProperties.filter((p) => scope.propertyIds.includes(p.id))
  const expenses = await prisma.propertyExpense.findMany({
    // Same visibility as the export: the entity's own rows, and rows on a
    // property in scope.
    where: {
      legalEntityId: { in: entities.map((entity) => entity.id) },
      OR: [{ propertyId: { in: scope.propertyIds } }, { propertyId: null }],
    },
    select: {
      id: true,
      description: true,
      category: true,
      amountCents: true,
      paidOn: true,
      recursMonthly: true,
      recurrenceEndsOn: true,
      documentId: true,
      property: { select: { name: true } },
      legalEntity: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: RECENT_LIMIT,
  })

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/money"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Money
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Property expenses</h1>
        <p className="text-muted-foreground text-sm">
          Property tax, the landlord policy, the management fee — what you pay without a
          vendor&rsquo;s bill. Each one lands on its Schedule E line and in the operating
          report&rsquo;s net.
        </p>
      </header>

      <section aria-labelledby="record-expense" className="flex flex-col gap-4 rounded-md border p-4">
        <h2 id="record-expense" className="text-lg font-semibold">
          Record an expense
        </h2>
        {entities.length === 0 ? (
          <p className="text-muted-foreground text-sm">No legal entities in scope.</p>
        ) : (
          <RecordExpenseForm
            action={recordPropertyExpense}
            entities={entities}
            properties={properties}
          />
        )}
      </section>

      <section aria-labelledby="recent-expenses" className="flex flex-col gap-3">
        <h2 id="recent-expenses" className="text-lg font-semibold">
          Recent expenses
        </h2>
        {expenses.length === 0 ? (
          <p className="text-muted-foreground text-sm">None recorded yet.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border break-words">
            {expenses.map((expense) => {
              const paidOn = friendlyBusinessDate(utcToBusinessDate(expense.paidOn))
              const endsOn = expense.recurrenceEndsOn
                ? friendlyBusinessDate(utcToBusinessDate(expense.recurrenceEndsOn))
                : null
              return (
                <li key={expense.id} className="flex flex-col gap-1 p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="min-w-0 font-medium">{expense.description}</span>
                    <span className="tabular-nums">
                      {formatCents(expense.amountCents)}
                      {expense.recursMonthly ? ' a month' : ''}
                    </span>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {expense.property?.name ?? `${expense.legalEntity.name} — whole entity`} ·{' '}
                    {SCHEDULE_E[expense.category]?.label ?? expense.category} ·{' '}
                    {!expense.recursMonthly
                      ? `paid ${paidOn}`
                      : endsOn
                        ? `monthly from ${paidOn} to ${endsOn}`
                        : `monthly since ${paidOn}`}
                  </p>
                  <div className="flex flex-wrap items-center gap-4">
                    {expense.documentId && (
                      <a
                        href={`/api/documents/${expense.documentId}/file`}
                        className="focus-visible:ring-ring text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
                      >
                        View the bill<span className="sr-only"> for {expense.description}</span>
                      </a>
                    )}
                    {expense.recursMonthly && !endsOn && (
                      <form action={stopExpenseRecurrence.bind(null, expense.id)}>
                        <button
                          type="submit"
                          className="hover:bg-secondary focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
                        >
                          Stop repeating<span className="sr-only"> {expense.description}</span>
                        </button>
                      </form>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
