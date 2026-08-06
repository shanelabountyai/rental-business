// Work-order approval thresholds and routing (MAINT-04, ROLE-02, R-026).
// Pure - no database, no Next.js. The authority primitive itself lives in
// packages/core/rbac/authority.ts (R-004); this decides when to consult it.
export * from './decide.ts'
export * from './thresholds.ts'
