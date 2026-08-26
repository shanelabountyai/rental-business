import { IssueCodeButton } from '@/components/leases/issue-code-button.tsx'
import { issueAccessCodeToTenant } from '@/lib/leases/access-code-actions.ts'

// Keys and codes at move-in (INSP-01, R-069). Withheld until move-in funds
// clear - `depositCleared` is read straight off whether a `Deposit` row
// exists (deposit-clearing-job.ts's own job creates it), so this panel never
// recomputes the money question itself.

const ACCESS_CODE_TYPE_LABELS: Record<string, string> = {
  LOCKBOX: 'Lockbox',
  SMART_LOCK: 'Smart lock',
  GATE: 'Gate',
  MAILBOX: 'Mailbox',
  OTHER: 'Other',
}

export interface AccessCodeRow {
  id: string
  type: string
  label: string | null
  /// ISO string, formatted by the caller from the query's `Date | null` -
  /// same as every other lease-page panel that takes a timestamp prop.
  issuedAt: string | null
}

export function AccessCodesPanel({
  leaseId,
  canIssue,
  depositCleared,
  codes,
}: {
  leaseId: string
  canIssue: boolean
  depositCleared: boolean
  codes: AccessCodeRow[]
}) {
  return (
    <section aria-labelledby="access-codes" className="flex flex-col gap-4 rounded-md border p-4">
      <h2 id="access-codes" className="text-sm font-semibold">
        Keys &amp; access codes
      </h2>

      {!depositCleared && (
        <p className="rounded-md bg-amber-50 p-2 text-sm text-amber-900">
          Move-in funds have not cleared yet. Codes are withheld until they
          do — certified funds (money order, cash, ACH, card) clear the
          moment they settle; a personal check clears after its hold period.
        </p>
      )}

      {codes.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No codes recorded for this unit yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {codes.map((code) => (
            <li key={code.id} className="flex items-center justify-between gap-2 text-sm">
              <span>
                {code.label ?? ACCESS_CODE_TYPE_LABELS[code.type] ?? code.type}
              </span>
              {code.issuedAt ? (
                <span className="text-muted-foreground">
                  Issued {code.issuedAt.slice(0, 10)}
                </span>
              ) : canIssue && depositCleared ? (
                <IssueCodeButton action={issueAccessCodeToTenant.bind(null, leaseId, code.id)} />
              ) : (
                <span className="text-muted-foreground">Not yet issued</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
