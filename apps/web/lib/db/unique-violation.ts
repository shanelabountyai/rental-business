/**
 * Postgres said this row already exists (Prisma P2002).
 *
 * The single copy. This predicate had been re-declared privately in five
 * modules - task creation, thread get-or-create, the job runner, the
 * notification recorder and R-030's verification write - all identical, and
 * all doing the same load-bearing job: turning "insert-then-catch" into a
 * safe get-or-create under concurrency, which is the only shape that works
 * when two requests race.
 *
 * NOT typed against Prisma's own error class on purpose. Importing
 * `Prisma.PrismaClientKnownRequestError` for an `instanceof` pulls the
 * generated client's runtime into every module that wants to catch a
 * duplicate, and R-010 and R-012 both hit the bundle-weight wall that
 * causes. The error code is a stable part of Prisma's public contract; the
 * class identity is not worth the import.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  )
}
