import { remoteTestDatabaseError } from './packages/db/test-database-guard.ts'

export default function setup() {
  const refusal = remoteTestDatabaseError(process.env.DATABASE_URL)
  if (refusal) throw new Error(refusal)
}
