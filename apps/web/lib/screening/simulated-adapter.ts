import 'server-only'

import { createHash, randomBytes } from 'node:crypto'
import { subtractMonths, utcToBusinessDate, type BusinessDate } from '@rental/core/scheduling'
import type {
  ScreeningAdapter,
  ScreeningAgency,
  ScreeningFault,
  ScreeningOrderInput,
  ScreeningOrderResult,
} from './adapter.ts'

// The simulated screening provider (D-7's simulated-adapter convention,
// R-060) - same posture as lib/listings/simulated-adapter.ts, whose own
// header this restates for a third D-7 adapter family:
//
// MINTS IDS IN A REALISTIC SHAPE, not `sim-1`.
//
// LOUD ABOUT WHAT IT IS: every call is logged with a `[screening:simulated]`
// prefix and `name` says `simulated`.
//
// HOLDS NO STATE OF ITS OWN. Report facts live on ScreeningReport - our own
// row, holding what the provider said (D-27) - never in memory here.
//
// THE REPORT FACTS ARE DETERMINISTIC FROM THE APPLICANT ID, AND FROM
// NOTHING ELSE (D-27's trap on this item specifically). If credit score or
// record flags were derived from Applicant.monthlyIncomeCents or any other
// field the criteria comparison also reads, the simulator would agree with
// the evaluator by construction and "results displayed alongside criteria"
// would prove nothing. A hash of the applicant id is the same discipline
// billing/card-expiry.ts already gives a card's simulated expiry: stable
// per id (so a test can predict it), and derived from nothing a decision
// reads.
//
// FAULT INJECTION IS A CONSTRUCTOR SEAM, not a global toggle - see
// lib/listings/simulated-adapter.ts's own header for why.

function providerId(): string {
  return `scr_${randomBytes(12).toString('hex')}`
}

/// LOUD ABOUT WHAT IT IS, same as `name = 'simulated'` above - a real
/// driver names the actual bureau it integrates with; this one does not
/// pretend to be Equifax/Experian/TransUnion.
export const SIMULATED_AGENCY: ScreeningAgency = {
  name: 'Simulated Consumer Reporting Agency (not a real bureau)',
  addressLine1: '1 Simulated Bureau Way',
  city: 'Austin',
  state: 'TX',
  postalCode: '78701',
  phone: '(800) 555-0100',
}

/// Reason statements shaped like a bureau's own, in the order a model
/// ranks them. Which ones an applicant gets is hashed from the id (D-27).
const SIMULATED_SCORE_FACTORS = [
  'Proportion of balances to credit limits is too high',
  'Length of time accounts have been established',
  'Too many accounts with balances',
  'Delinquency on accounts',
  'Number of recent inquiries',
  'Lack of recent installment loan information',
]

function factsFor(
  applicantId: string,
  today: BusinessDate,
): {
  creditScore: number
  creditScoreRangeLow: number
  creditScoreRangeHigh: number
  creditScoreFactors: string[]
  creditScoreOn: BusinessDate
  creditScoreSource: string
  evictionRecordFound: boolean
  criminalRecordFound: boolean
  evictionRecordOn?: BusinessDate
  criminalRecordOn?: BusinessDate
} {
  const digest = createHash('sha256').update(applicantId).digest()
  const evictionRecordFound = digest[1] % 5 === 0 // ~20% of the time.
  const criminalRecordFound = digest[2] % 8 === 0 // ~12.5% of the time.
  // A record 1-180 months old - deliberately NOT limited to the window the
  // order asked for (D-27), so records outside it reach core's own check.
  return {
    // 500-849, a realistic FICO-shaped range.
    creditScore: 500 + (digest[0] % 350),
    creditScoreRangeLow: 300,
    creditScoreRangeHigh: 850,
    // 2-6 factors, so a list longer than the four the notice may show,
    // with inquiries fifth, reaches core's own cap.
    creditScoreFactors: SIMULATED_SCORE_FACTORS.slice(0, 2 + (digest[5] % 5)),
    creditScoreOn: today,
    creditScoreSource: 'Simulated scoring model (not a real credit score)',
    evictionRecordFound,
    criminalRecordFound,
    ...(evictionRecordFound && { evictionRecordOn: subtractMonths(today, 1 + (digest[3] % 180)) }),
    ...(criminalRecordFound && { criminalRecordOn: subtractMonths(today, 1 + (digest[4] % 180)) }),
  }
}

export class SimulatedScreeningAdapter implements ScreeningAdapter {
  readonly name = 'simulated'

  constructor(
    private readonly opts: {
      /// Called before every order(). Returning a fault code fails that
      /// order instead of completing it.
      fault?: (input: ScreeningOrderInput) => ScreeningFault | null
    } = {},
  ) {}

  async order(input: ScreeningOrderInput): Promise<ScreeningOrderResult> {
    const id = providerId()
    const fault = this.opts.fault?.(input)
    if (fault) {
      console.info(`[screening:simulated] FAULT (${fault}) ordering for ${input.applicantId}`)
      return { providerId: id, status: 'FAILED', faultCode: fault }
    }

    const facts = factsFor(input.applicantId, utcToBusinessDate(new Date()))
    console.info(`[screening:simulated] completed order ${id} for ${input.applicantId}`)
    return { providerId: id, status: 'COMPLETE', ...facts, agency: SIMULATED_AGENCY }
  }
}

// Exported so a test - or a caller building an expectation - can compute
// the same facts the simulator will return, without re-deriving the hash
// logic. Never used by the evaluator itself: that reads ScreeningReport's
// own persisted columns, not this function (D-27 again).
export function simulatedScreeningFacts(
  applicantId: string,
  today: BusinessDate = utcToBusinessDate(new Date()),
) {
  return factsFor(applicantId, today)
}
