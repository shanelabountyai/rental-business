// Comms threading (COMM-01, R-017): thread identity, phone normalization for
// inbound routing, the routing decision itself, and message validation. Pure -
// no database, no provider.
//
// The core principle this module serves, from the master PRD's own COMM
// epic: "every communication is potential evidence. One threaded,
// timestamped, immutable history per tenancy, per property, per vendor -
// regardless of channel."
export * from './delivery-status.ts'
export * from './opt-out.ts'
export * from './phone.ts'
export * from './sms-intake.ts'
export * from './threads.ts'
export * from './validate.ts'
export * from './webhook-signature.ts'
