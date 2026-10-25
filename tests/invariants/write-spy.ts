// Every Prisma operation a call made. Its own module, importing nothing,
// because the test file's `@rental/db` mock loads it while `@rental/db` itself
// is still being mocked: anything that imported the client here would deadlock.
export type Op = { name: string; write: boolean }
export const ops: Op[] = []

const WRITE =
  /^(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)$/
// Raw SQL writes only when it says so: the rate limiter's advisory lock goes
// through $executeRaw and changes nothing.
const RAW_WRITE = /^\s*(insert|update|delete|truncate|merge)\b/i

type Query = { model?: string; operation: string; args: unknown; query: (args: unknown) => Promise<unknown> }

function rawSql(args: unknown): string {
  const a = args as { sql?: string; strings?: string[] } | unknown[] | undefined
  if (Array.isArray(a)) return Array.isArray(a[0]) ? (a[0] as string[]).join('?') : String(a[0])
  return a?.sql ?? a?.strings?.join('?') ?? ''
}

export function withWriteSpy<C>(client: C): C {
  return (client as unknown as { $extends: (extension: unknown) => C }).$extends({
    query: {
      async $allOperations({ model, operation, args, query }: Query) {
        const op: Op = model
          ? { name: `${model}.${operation}`, write: WRITE.test(operation) }
          : { name: `raw ${rawSql(args).trim().slice(0, 60)}`, write: RAW_WRITE.test(rawSql(args)) }
        ops.push(op)
        let result: unknown
        try {
          result = await query(args)
        } catch (e) {
          // A write that threw changed nothing: `update({ where: { id, orgId } })`
          // on another org's id throws, and that is the scoping working.
          op.write = false
          throw e
        }
        // A *Many or raw write that matched no row changed nothing: the shape
        // of an id lookup filtered by its org (`deleteMany({ id, orgId })`).
        const count = typeof result === 'number' ? result : (result as { count?: unknown } | null)?.count
        if (op.write && count === 0) op.write = false
        return result
      },
    },
  })
}

// Who the next call is made as. Here for the same reason as `ops`: the test
// file's `@/auth.ts` mock reads it while the module graph is still loading.
export type Principal = { id: string; kind: 'staff' | 'tenant' | 'guarantor'; email: null; name: string; mfaEnrolled: boolean; mfaVerified: boolean }
export const session: { principal: Principal | null } = { principal: null }
