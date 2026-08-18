import 'server-only'

import { randomBytes } from 'node:crypto'
import type {
  CompletionCertificateResult,
  CreateEnvelopeInput,
  EsignAdapter,
  EsignEnvelopeResult,
  EsignFault,
} from './adapter.ts'

// The simulated e-signature provider (D-7's simulated-adapter convention,
// R-063) - same posture as lib/screening/simulated-adapter.ts, whose own
// header this restates for the third D-7 adapter family:
//
// MINTS IDS IN A REALISTIC SHAPE, not `sim-1`.
//
// LOUD ABOUT WHAT IT IS: every call is logged with a `[esign:simulated]`
// prefix and `name` says `simulated`.
//
// HOLDS NO STATE OF ITS OWN. See adapter.ts's own header - completion
// certificate text is built from the signer facts the CALLER passes in,
// never from anything remembered here.
//
// FAULT INJECTION IS A CONSTRUCTOR SEAM, not a global toggle - see
// lib/screening/simulated-adapter.ts's own header for why.

function envelopeId(): string {
  return `env_${randomBytes(12).toString('hex')}`
}

function signerId(): string {
  return `sig_${randomBytes(8).toString('hex')}`
}

export class SimulatedEsignAdapter implements EsignAdapter {
  readonly name = 'simulated'

  constructor(
    private readonly opts: {
      fault?: (input: { op: string }) => EsignFault | null
    } = {},
  ) {}

  async createEnvelope(input: CreateEnvelopeInput): Promise<EsignEnvelopeResult> {
    const fault = this.opts.fault?.({ op: 'createEnvelope' })
    if (fault) {
      console.info(`[esign:simulated] FAULT (${fault}) creating envelope for lease ${input.leaseId}`)
      throw new Error(`simulated esign fault: ${fault}`)
    }
    const providerId = envelopeId()
    const signerProviderIds: Record<string, string> = {}
    for (const signer of input.signers) {
      signerProviderIds[signer.localId] = signerId()
    }
    console.info(
      `[esign:simulated] created envelope ${providerId} for lease ${input.leaseId} (${input.signers.length} signer(s))`,
    )
    return { providerId, signerProviderIds }
  }

  async recordView(input: { providerId: string; signerProviderId: string }) {
    console.info(`[esign:simulated] viewed ${input.signerProviderId} on ${input.providerId}`)
    return { viewedAt: new Date() }
  }

  async recordSignature(input: {
    providerId: string
    signerProviderId: string
    signedName: string
    ip: string | null
  }) {
    const fault = this.opts.fault?.({ op: 'recordSignature' })
    if (fault) {
      console.info(`[esign:simulated] FAULT (${fault}) signing ${input.signerProviderId}`)
      throw new Error(`simulated esign fault: ${fault}`)
    }
    console.info(`[esign:simulated] signed ${input.signerProviderId} on ${input.providerId} as "${input.signedName}"`)
    return { signedAt: new Date() }
  }

  async completionCertificate(input: {
    providerId: string
    documentSha256: string
    signers: readonly {
      name: string
      role: 'TENANT' | 'GUARANTOR'
      order: number
      signedAt: Date
      signedName: string
      signedIp: string | null
    }[]
  }): Promise<CompletionCertificateResult> {
    const generatedAt = new Date()
    const lines = [
      'CERTIFICATE OF COMPLETION',
      '(Simulated e-signature provider - not a real vendor)',
      '',
      `Envelope: ${input.providerId}`,
      `Document hash (SHA-256): ${input.documentSha256}`,
      `Certificate generated: ${generatedAt.toISOString()}`,
      '',
      'Signers:',
      ...[...input.signers]
        .sort((a, b) => a.order - b.order)
        .map(
          (s) =>
            `  ${s.order}. ${s.signedName} (${s.role.toLowerCase()}) - signed ${s.signedAt.toISOString()}${
              s.signedIp ? ` from ${s.signedIp}` : ''
            }`,
        ),
    ]
    console.info(`[esign:simulated] completion certificate for ${input.providerId}`)
    return { certificateText: lines.join('\n'), generatedAt }
  }

  async voidEnvelope(input: { providerId: string; reason: string }) {
    console.info(`[esign:simulated] voided ${input.providerId}: ${input.reason}`)
    return { voidedAt: new Date() }
  }
}
