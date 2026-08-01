// Authentication primitives (R-003). Pure functions and crypto only - no
// database, no Prisma, no Next.js. The app layer owns storage and transport;
// this package owns the decisions, which is what makes them testable without
// standing anything up.
//
// R-004 builds authorization on top of this. Keep the split: this package
// answers "who is this?", never "may they?".

export * from './password.ts'
export * from './rate-limit.ts'
export * from './secret-box.ts'
export * from './tokens.ts'
export * from './totp.ts'
