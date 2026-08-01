// Domain-event vocabulary (R-006). Pure: the names and the envelope shape.
// The outbox that stores them and the dispatcher that delivers them live in
// apps/web/lib/jobs, because both need a database.
export * from './types.ts'
