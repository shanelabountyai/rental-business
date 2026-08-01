// Authorization (R-004). Pure decisions: no database, no Next.js, no session.
//
// The three functions D-5 names by hand - can(), propertyScope() and
// checkMonetaryAuthority() - live here, and none of them contains a bypass.
// Unrestricted access is an ordinary assignment row with the `owner` role and
// a null scope. If you are ever tempted to add `if (actor.isOwner) return
// true`, that is the flag D-5 forbids, wearing a different hat.
//
// R-003 answers "who is this?"; this package answers "may they?".
export * from './authority.ts'
export * from './can.ts'
export * from './permissions.ts'
