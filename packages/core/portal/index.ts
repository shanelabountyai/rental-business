// The tenant portal's pure half (R-018): what a tenant may see of their own
// file (DOC-03). No database, no Next.js - the app layer builds the scope and
// applies these rules in its queries.
export * from './access.ts'
