import { AsyncLocalStorage } from 'node:async_hooks'
import type { PrismaClient } from './generated/client/index.js'

/**
 * ROW-LEVEL SECURITY, THE BACKSTOP (R-287a, PRD 10 §1.6, D-317, D-391).
 *
 * The migration `20261110100000_row_level_security` puts an `org_isolation`
 * policy on every org-owned table, bound to the NOLOGIN role `rental_rls`.
 * This file is the other half: while an org is in context, every query runs
 * inside a transaction that first does
 *
 *   set_config('role', 'rental_rls', true), set_config('app.org_id', <org>, true)
 *
 * so a `where` naming another org's id comes back empty and a write into
 * another org is refused - whatever the application code asked for.
 *
 * Who puts an org in context: the guards (`requireStaff`, `requireTenant`,
 * `requireScope`, the guarantor and portal guards) via `openOrgContext`, and each
 * cron child via `withOrg`. No org in context means the connecting role,
 * unchanged - sign-in, token links, webhooks, the platform console, seeds and
 * every unit test that never reaches a guard. That is the bypass, and it is
 * the absence of a context rather than a flag anyone can set.
 *
 * ENFORCED ONLY WHEN RLS_ENFORCE=1 (D-391): vitest, the e2e server and CI.
 * Production does not wrap anything yet - R-287b measures the Neon cost of a
 * transaction per query and decides, and owns auditing the bypass if it goes
 * on there.
 */

type Context = { orgId?: string; inBatch?: true; inTx?: true }

const storage = new AsyncLocalStorage<Context>()

/// Opens the context in the CALLER'S frame and returns the setter that fills
/// it in once the org is known. Two halves because a guard learns the org
/// only after an `await`, and `enterWith` called after an await never reaches
/// the caller - its continuation keeps the context it had when it awaited.
/// So: call this synchronously, before the guard's first await, in a
/// function that is not itself `async`. Until the setter runs, queries go out
/// as the connecting role, which is what loading the actor needs.
export function openOrgContext(): (orgId: string) => void {
  const context: Context = { orgId: storage.getStore()?.orgId }
  storage.enterWith(context)
  return (orgId) => {
    context.orgId = orgId
  }
}

/// Tests only. A test calls an action directly, with no request around it
/// to bound the context its guard opens, so the context would ride on into
/// every later test in the worker. `vitest.setup.ts` clears it before each.
export function resetOrgContext(): void {
  storage.disable()
}

/// Tests only: an action called directly gets the boundary a request gives
/// it in the app, so the org its guard opens ends when it returns - and the
/// test's own fixture reads after it are not filtered to that org.
export function asRequest<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({}, fn)
}

export function withOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ orgId }, fn)
}

export function rlsOrgId(): string | undefined {
  return storage.getStore()?.orgId
}

export function rlsEnforced(): boolean {
  return process.env.RLS_ENFORCE === '1'
}

/// `base` is the plain client: its own calls go through no hook, which is
/// what lets the hook wrap a query without recursing into itself.
export function withRowLevelSecurity(base: PrismaClient): PrismaClient {
  const setRole = (client: PrismaClient, orgId: string) =>
    client.$executeRaw`SELECT set_config('role', 'rental_rls', true), set_config('app.org_id', ${orgId}, true)`

  const enforce = async ({ args, query }: { args: unknown; query: (args: unknown) => Promise<unknown> }) => {
    const context = storage.getStore()
    const orgId = context?.orgId
    if (!orgId || context.inBatch || context.inTx) return query(args)
    const [, result] = await base.$transaction([setRole(base, orgId), query(args) as never])
    return result
  }

  const extended = base.$extends({
    query: { $allModels: { $allOperations: enforce } },
  } as never) as unknown as PrismaClient

  // Raw queries are not left to a hook: Prisma runs a raw query's hook
  // outside the caller's async context (measured: the store reads undefined),
  // so the org is read here, when the method is called. The base promise is
  // returned so a batch can still take it - our batch has already switched
  // role - and awaiting it directly runs it on its own enforced transaction.
  type Raw = '$queryRaw' | '$executeRaw' | '$queryRawUnsafe' | '$executeRawUnsafe'
  const raws = new Set<string | symbol>(['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe'])
  const raw = (operation: Raw) => (...args: unknown[]) => {
    const call = (client: unknown) =>
      (client as Record<Raw, (...a: unknown[]) => Promise<unknown>>)[operation].apply(client, args)
    const promise = call(base)
    const context = storage.getStore()
    const orgId = context?.orgId
    if (!orgId || context.inTx) return promise
    const run = () =>
      base.$transaction(async (tx) => {
        await setRole(tx as PrismaClient, orgId)
        return call(tx)
      })
    return Object.assign(promise, {
      then: (ok?: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => run().then(ok, fail),
      catch: (fail?: (e: unknown) => unknown) => run().catch(fail),
      finally: (done?: () => void) => run().finally(done),
    })
  }

  return wrap(extended)

  // The hook above cannot nest inside a transaction, so `$transaction`
  // switches role once at the top and marks the context `inTx`, which the
  // hook and the raw methods pass straight through. `client` is whichever
  // extension is outermost - the harness's write spy extends this one - so
  // its hooks still see every query, `tx`'s included.
  //
  // ponytail: a callback that reaches for the GLOBAL `prisma` instead of its
  // `tx` runs on another connection as the connecting role, unenforced - as
  // it is unatomic today. Enforcing it needs the tx's identity, not a flag.
  function wrap(client: PrismaClient): PrismaClient {
    const plain = (client.$transaction as (...a: unknown[]) => Promise<unknown>).bind(client)
    const transaction = ((input: unknown, options?: unknown) => {
      const orgId = storage.getStore()?.orgId
      if (!orgId) return plain(input, options)
      if (typeof input === 'function') {
        return storage.run({ orgId, inTx: true }, () =>
          plain(async (tx: PrismaClient) => {
            await setRole(tx, orgId)
            return (input as (tx: unknown) => unknown)(tx)
          }, options),
        )
      }
      // A batch: its items' hooks run when the batch does, inside this run.
      return storage.run({ orgId, inBatch: true }, async () => {
        const [, ...results] = (await plain([setRole(base, orgId), ...(input as unknown[])], options)) as unknown[]
        return results
      })
    }) as PrismaClient['$transaction']

    // A test may swap `$transaction` by assignment (billing.test.ts does, to
    // throw mid-projection); the swap is held here so it wraps ours.
    let current: unknown = transaction
    return new Proxy(client, {
      get: (target, prop, receiver) => {
        if (prop === '$transaction') return current
        if (raws.has(prop)) return raw(prop as Raw)
        if (prop === '$extends') return (...a: unknown[]) => wrap((target.$extends as unknown as (...b: unknown[]) => PrismaClient)(...a))
        return Reflect.get(target, prop, receiver)
      },
      set: (target, prop, value, receiver) => {
        if (prop !== '$transaction') return Reflect.set(target, prop, value, receiver)
        current = value
        return true
      },
    })
  }
}
