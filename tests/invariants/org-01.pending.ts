// ORG-01's ratchet (R-286a, D-341). Each action here reads the database before
// it refuses an anonymous caller - loads the record, then lets
// requirePermission() redirect - so a stranger is told "no longer exists" for
// a guessed id and "sign in" for a real one. None of them writes.
//
// R-286b emptied this list: the guard moves first, which ORG-04's org-scoped
// lookup needs anyway. The test asserts the findings equal this list EXACTLY,
// so an action fixed must leave it and a new action cannot join it.
export const ORG_01_PENDING: string[] = []
