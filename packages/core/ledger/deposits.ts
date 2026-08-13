import { type Cents, assertCents } from '../money/money.ts'

// Security deposits (PAY-07, R-041; D-4).
//
// THE ONE IDEA THIS FILE EXISTS TO ENFORCE: a security deposit is not income.
// It is the tenant's money, held on trust, and owed back to them minus
// whatever the landlord can lawfully prove at move-out. A product that adds
// it to revenue reports a number the owner has not earned, and - worse -
// invites spending money that has to be returned. Several states require it
// to sit in a separate account for exactly that reason.
//
// So the held amount is modelled as a LIABILITY from the start, before there
// is any income reporting to keep it out of. R-050's dashboard and every
// future export get a function that already answers "how much of this is not
// ours", rather than a `depositCents` column they have to remember about.
//
// Pure, and in core, because every number here is one a statute can change
// (D-4) and none of it needs a database.

/// The deposit arrangement on a lease. Not every tenancy involves the
/// landlord holding cash.
export type DepositArrangement =
  /// Cash held on trust. The liability case.
  | 'CASH'
  /// A surety bond or deposit-replacement product. The tenant pays a premium
  /// to a third party and the landlord holds NOTHING - so there is no
  /// liability, nothing to escrow, no interest to pay and nothing to return.
  /// Recording it as a zero cash deposit would be true but useless; recording
  /// it as an arrangement is what stops somebody at move-out hunting for
  /// money that was never collected.
  | 'SURETY_BOND'
  /// No deposit of any kind.
  | 'NONE'

export interface DepositRule {
  /// The statutory ceiling, in basis points of monthly rent. Null means the
  /// state sets no cap - which is the case in Texas, and is NOT the same as
  /// a cap of zero.
  depositMaxBps?: number | null
  /// Must the money sit in a separate account?
  depositEscrowRequired: boolean
  /// Must it earn interest for the tenant?
  depositInterestRequired: boolean
}

/**
 * The most this lease may lawfully hold.
 *
 * Null means no statutory ceiling. Callers must not read that as zero - the
 * difference is "charge what you like" versus "charge nothing", and getting
 * it backwards either blocks every lease in Texas or permits an unlawful
 * deposit everywhere else.
 */
export function depositCapCents(rule: DepositRule, rentCents: Cents): Cents | null {
  if (rule.depositMaxBps == null) return null
  assertCents(rentCents, 'rent')
  // Basis points: 10_000 bps = one month's rent. Rounded DOWN, because a cap
  // rounded up is a cap exceeded.
  return Math.floor((rentCents * rule.depositMaxBps) / 10_000)
}

export interface DepositViolation {
  field: 'depositDollars'
  message: string
}

/**
 * Is this deposit lawful here?
 *
 * Checked at the point somebody types it, not at move-out. An over-collected
 * deposit is a statutory violation on the day it is taken, and in several
 * states the remedy runs to multiples of the excess - so discovering it two
 * years later, when the tenant's lawyer does, is the expensive way.
 */
export function validateDepositAmount(args: {
  depositCents: Cents
  rentCents: Cents
  arrangement: DepositArrangement
  rule: DepositRule
}): DepositViolation[] {
  const { depositCents, rentCents, arrangement, rule } = args

  if (arrangement !== 'CASH') {
    // Nothing is held, so nothing can exceed a cap. A non-zero amount
    // alongside a surety bond is a data-entry mistake worth naming rather
    // than silently ignoring: it is how a tenant gets chased at move-out for
    // money nobody ever took.
    if (depositCents > 0) {
      return [
        {
          field: 'depositDollars',
          message:
            arrangement === 'SURETY_BOND'
              ? 'This lease uses a surety bond, so no cash deposit is held. Set the amount to zero or switch to a cash deposit.'
              : 'This lease holds no deposit. Set the amount to zero or choose a deposit type.',
        },
      ]
    }
    return []
  }

  const cap = depositCapCents(rule, rentCents)
  if (cap != null && depositCents > cap) {
    return [
      {
        field: 'depositDollars',
        message: `This state caps the deposit at ${formatDollars(cap)} for ${formatDollars(rentCents)} rent. Lower the deposit or check the jurisdiction rule.`,
      },
    ]
  }
  return []
}

/**
 * What the landlord is holding that is not theirs.
 *
 * Deliberately NOT derived from `Lease.depositCents`, which is what the lease
 * says should be collected - an intention. A liability is what was actually
 * received and not yet returned, and the two differ for every lease where the
 * tenant paid late, paid partially, or moved out.
 */
export function depositHeldCents(
  movements: readonly { amountCents: Cents; kind: 'RECEIVED' | 'RETURNED' | 'APPLIED' }[],
): Cents {
  let held = 0
  for (const movement of movements) {
    assertCents(movement.amountCents, 'deposit movement')
    // RETURNED is money given back; APPLIED is money kept against proven
    // damage or arrears. Both reduce the liability, and they are distinct
    // because only one of them is income - which is the whole point of
    // separating this from rent in the first place (R-071 owns the
    // disposition that decides which).
    held += movement.kind === 'RECEIVED' ? movement.amountCents : -movement.amountCents
  }
  return held
}

/**
 * What the jurisdiction demands of money being held.
 *
 * Returned as a list of obligations rather than two booleans so a screen can
 * render them without knowing which rules exist - and so a state that adds a
 * third obligation later does not need every caller edited.
 */
export function depositObligations(
  rule: DepositRule,
  arrangement: DepositArrangement,
): string[] {
  // Nothing held, nothing owed. A surety bond has its own consumer-protection
  // rules, but none of them are about money this landlord is sitting on.
  if (arrangement !== 'CASH') return []

  const obligations: string[] = []
  if (rule.depositEscrowRequired) {
    obligations.push('Must be held in a separate account from operating funds.')
  }
  if (rule.depositInterestRequired) {
    obligations.push('Must earn interest for the tenant.')
  }
  return obligations
}

function formatDollars(cents: Cents): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}
