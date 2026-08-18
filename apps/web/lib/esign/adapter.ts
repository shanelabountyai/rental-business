// The e-signature provider contract (LEASE-06, DOC-02, R-063; D-7: the
// third of the three named simulated adapters, after
// SimulatedScreeningAdapter/SimulatedSyndicationAdapter). Same seam shape as
// lib/screening/adapter.ts - see that file's own header for why this
// repeats the pattern rather than inventing a new one.
//
// HOLDS NO STATE OF ITS OWN (D-27, restated for a third adapter family).
// Every fact about who signed what, when, and from where lives on
// LeaseEnvelope/LeaseSigner - our own rows. `completionCertificate` below
// takes the signer facts as INPUT rather than reading them back from
// anywhere the adapter tracked itself, the same discipline
// `simulatedScreeningFacts` keeps for report facts.

export interface EsignSignerInput {
  /// The LOCAL id (LeaseSigner.id) - the provider hands back its own id for
  /// each signer, keyed to this one so the caller can match them up.
  localId: string
  order: number
  role: 'TENANT' | 'GUARANTOR'
  name: string
  email: string | null
}

export interface EsignEnvelopeResult {
  /// The provider's own envelope id (D-27: never invented by us).
  providerId: string
  /// localId -> the provider's own signer id.
  signerProviderIds: Record<string, string>
}

export interface CreateEnvelopeInput {
  leaseId: string
  /// The unsigned draft PDF's hash - what a real provider would be handed
  /// to start the ceremony against.
  documentSha256: string
  signers: readonly EsignSignerInput[]
}

export interface EsignSignerFact {
  name: string
  role: 'TENANT' | 'GUARANTOR'
  order: number
  signedAt: Date
  signedName: string
  signedIp: string | null
}

export interface CompletionCertificateResult {
  certificateText: string
  generatedAt: Date
}

/// §14 of the master PRD asks every simulated adapter for the fault
/// subset that applies to its own call shape. "Delayed webhook" does not
/// apply here either, for the same reason SCREENING_FAULTS leaves it out:
/// the simulated driver completes every call inline.
export const ESIGN_FAULTS = ['timeout', 'provider_error'] as const
export type EsignFault = (typeof ESIGN_FAULTS)[number]

export class EsignError extends Error {
  readonly code: EsignFault

  constructor(code: EsignFault, message: string) {
    super(message)
    this.name = 'EsignError'
    this.code = code
  }
}

export interface EsignAdapter {
  readonly name: string
  createEnvelope(input: CreateEnvelopeInput): Promise<EsignEnvelopeResult>
  recordView(input: { providerId: string; signerProviderId: string }): Promise<{ viewedAt: Date }>
  recordSignature(input: {
    providerId: string
    signerProviderId: string
    signedName: string
    ip: string | null
  }): Promise<{ signedAt: Date }>
  completionCertificate(input: {
    providerId: string
    documentSha256: string
    signers: readonly EsignSignerFact[]
  }): Promise<CompletionCertificateResult>
  voidEnvelope(input: { providerId: string; reason: string }): Promise<{ voidedAt: Date }>
}
