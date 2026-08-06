// Entry-notice compliance for scheduled visits (MAINT-05, COMM-02, D-4,
// R-027). Pure - no database, no Next.js. The notice HOURS always arrive as
// an argument from JurisdictionRule; nothing here hardcodes a period.
export * from './notice.ts'
export * from './validate.ts'
