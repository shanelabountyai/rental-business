import { randomUUID } from 'node:crypto'
import type {
  IdentityAdapter,
  IdentityCheckOutcome,
  IssueCodeInput,
  IssuedCode,
  LockEventRecord,
  LockFault,
  SmartLockAdapter,
} from './adapter.ts'

// The simulated smart lock and identity provider (LEASE-08, R-094; D-7).
//
// FAULT INJECTION IS A CONSTRUCTOR SEAM, not a global toggle - the same
// shape SimulatedEsignAdapter uses, so a test can make one call fail without
// making every call in the process fail.

/// In-process state. A real device holds this; the simulator has to hold it
/// somewhere, and holding it HERE rather than reading our own tables is what
/// keeps D-27 true - `events()` can report an unlock we never issued, which
/// is exactly the case an entry log exists for.
interface SimulatedDevice {
  codes: Map<string, { code: string; validFrom: Date; validTo: Date; revoked: boolean }>
  events: LockEventRecord[]
}

export class SimulatedSmartLockAdapter implements SmartLockAdapter {
  readonly name = 'simulated-lock'
  private readonly devices = new Map<string, SimulatedDevice>()

  constructor(
    private readonly opts: {
      fault?: (input: { op: string; externalId: string }) => LockFault | null
      /// Overridable so a test can assert on a known code rather than
      /// scraping one out of a page.
      mintCode?: () => string
    } = {},
  ) {}

  private device(externalId: string): SimulatedDevice {
    let device = this.devices.get(externalId)
    if (!device) {
      device = { codes: new Map(), events: [] }
      this.devices.set(externalId, device)
    }
    return device
  }

  private check(op: string, externalId: string): void {
    const fault = this.opts.fault?.({ op, externalId })
    if (fault) {
      console.info(`[lock:simulated] FAULT (${fault}) on ${op} for device ${externalId}`)
      throw new Error(`simulated lock fault: ${fault}`)
    }
  }

  async issueCode(input: IssueCodeInput): Promise<IssuedCode> {
    this.check('issueCode', input.externalId)
    const device = this.device(input.externalId)
    const providerRef = `sim-code-${randomUUID().slice(0, 12)}`
    // Six digits, which is what the lockboxes in this market actually take.
    const code =
      this.opts.mintCode?.() ??
      String(Math.floor(Math.random() * 900_000) + 100_000)
    device.codes.set(providerRef, {
      code,
      validFrom: input.validFrom,
      validTo: input.validTo,
      revoked: false,
    })
    return { providerRef, code }
  }

  async revokeCode(input: { externalId: string; providerRef: string }): Promise<void> {
    this.check('revokeCode', input.externalId)
    const existing = this.device(input.externalId).codes.get(input.providerRef)
    // Idempotent by contract: an unknown or already-revoked code is a
    // success, because the instant kill must never fail on a second press.
    if (existing) existing.revoked = true
  }

  async events(input: { externalId: string; since: Date }): Promise<LockEventRecord[]> {
    this.check('events', input.externalId)
    return this.device(input.externalId)
      .events.filter((event) => event.occurredAt.getTime() >= input.since.getTime())
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
  }

  /**
   * Somebody types a code at the door. Test-only, and the ONLY way an event
   * gets into this simulator.
   *
   * The device decides, from ITS OWN state, whether the code opens the door -
   * not from anything this product believes about the code. That is what
   * makes a `DENIED` row reachable, and what makes it possible for the log to
   * disagree with us.
   */
  simulateEntry(input: { externalId: string; code: string; at: Date }): LockEventRecord {
    const device = this.device(input.externalId)
    const match = [...device.codes.entries()].find(
      ([, value]) =>
        value.code === input.code &&
        !value.revoked &&
        value.validFrom.getTime() <= input.at.getTime() &&
        value.validTo.getTime() >= input.at.getTime(),
    )
    const event: LockEventRecord = {
      providerRef: `sim-event-${randomUUID().slice(0, 12)}`,
      kind: match ? 'UNLOCKED' : 'DENIED',
      occurredAt: input.at,
      actorLabel: match ? 'Keypad code' : 'Keypad code (rejected)',
      codeProviderRef: match?.[0] ?? null,
    }
    device.events.push(event)
    return event
  }

  /// Test-only: an entry this product never issued a code for - a key, a
  /// neighbour, an old code. The row an entry log exists to surface.
  simulateUnknownEntry(input: { externalId: string; at: Date; label: string }): LockEventRecord {
    const event: LockEventRecord = {
      providerRef: `sim-event-${randomUUID().slice(0, 12)}`,
      kind: 'UNLOCKED',
      occurredAt: input.at,
      actorLabel: input.label,
      codeProviderRef: null,
    }
    this.device(input.externalId).events.push(event)
    return event
  }
}

/**
 * The simulated identity provider.
 *
 * IT ANSWERS WITH THE NAME IT WAS TOLD, AND NOTHING ELSE (D-27). A simulator
 * that echoed the `Prospect` row's own name would make `namesAgree` true by
 * construction and leave the mismatch branch - the reason this feature
 * verifies anybody at all - dead code that no test could reach.
 *
 * `FAILED` when the caller submits nothing readable, which is the real
 * shape of the failure: a photo too dark to read produces no name.
 */
export class SimulatedIdentityAdapter implements IdentityAdapter {
  readonly name = 'simulated-identity'

  constructor(
    private readonly opts: { fault?: (input: { prospectId: string }) => LockFault | null } = {},
  ) {}

  async verify(input: {
    prospectId: string
    documentName: string
  }): Promise<IdentityCheckOutcome> {
    const fault = this.opts.fault?.({ prospectId: input.prospectId })
    if (fault) {
      console.info(`[identity:simulated] FAULT (${fault}) verifying ${input.prospectId}`)
      throw new Error(`simulated identity fault: ${fault}`)
    }
    const documentName = input.documentName.trim()
    if (!documentName) {
      return { reference: `sim-id-${randomUUID().slice(0, 12)}`, result: 'FAILED', documentName: '' }
    }
    return {
      reference: `sim-id-${randomUUID().slice(0, 12)}`,
      result: 'VERIFIED',
      documentName,
    }
  }
}
