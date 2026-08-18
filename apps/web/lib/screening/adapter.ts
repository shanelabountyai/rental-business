// The screening provider contract (LEASE-04, R-060; D-7: the second of the
// three named simulated adapters, after SimulatedSyndicationAdapter). One
// seam, matching the shape lib/listings/adapter.ts already gives its own
// sibling - see that file's own header for why this repeats the pattern
// rather than inventing a new one.

/// What was handed to the provider is exactly `applicantId` - nothing
/// SSN-shaped, matching the whole-schema rule in packages/db/prisma/schema.prisma's
/// own header. A real provider-hosted flow would take an applicant and a
/// return URL and hand back a report reference over its own webhook; this
/// interface has no wider a surface than that.
export interface ScreeningOrderInput {
  applicantId: string
}

export interface ScreeningOrderResult {
  /// What the provider says this order's id is - stored on
  /// ScreeningReport.providerId, never invented by us and never read back
  /// from our own row either (D-27).
  providerId: string
  status: 'COMPLETE' | 'FAILED'
  /// Present only when status is FAILED.
  faultCode?: ScreeningFault
  /// Present only when status is COMPLETE. NEVER derived from anything the
  /// criteria comparison also reads (D-27) - see simulated-adapter.ts's own
  /// header for how the simulated driver keeps that true.
  creditScore?: number
  evictionRecordFound?: boolean
  criminalRecordFound?: boolean
}

/// §14 of the master PRD asks every simulated adapter to be able to produce
/// "timeout, malformed response, delayed webhook, partial failure".
/// "Delayed webhook" does not apply - the simulated driver completes
/// inline, with no async callback to delay - so it is left out, the same
/// call SYNDICATION_FAULTS already made for the identical reason.
export const SCREENING_FAULTS = ['timeout', 'malformed_response', 'provider_error'] as const
export type ScreeningFault = (typeof SCREENING_FAULTS)[number]

export class ScreeningError extends Error {
  readonly code: ScreeningFault

  constructor(code: ScreeningFault, message: string) {
    super(message)
    this.name = 'ScreeningError'
    this.code = code
  }
}

export interface ScreeningAdapter {
  readonly name: string
  order(input: ScreeningOrderInput): Promise<ScreeningOrderResult>
}
