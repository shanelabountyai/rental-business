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
        if (model) ops.push({ name: `${model}.${operation}`, write: WRITE.test(operation) })
        else {
          const sql = rawSql(args)
          ops.push({ name: `raw ${sql.trim().slice(0, 60)}`, write: RAW_WRITE.test(sql) })
        }
        return query(args)
      },
    },
  })
}
