// Audit log service (R-005). CLAUDE.md: "The evidence trail is the product."
//
// One write path, so there is one place to audit for mistakes; unconditional
// redaction, so a row snapshot can never copy a password hash into a table
// that cannot be cleaned up; and a transaction-aware writer, so an entry and
// the change it describes are atomic.
//
// The append-only guarantee itself is not here - it is a database trigger from
// R-002, because "append-only by convention" survives until the first incident.
export * from './events.ts'
export * from './record.ts'
export * from './redact.ts'
