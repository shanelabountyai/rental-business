import {
  EMERGENCY_CATEGORIES,
  EMERGENCY_DEFINITIONS,
  type EmergencyCategory,
  isEmergencyCategory,
} from '@rental/core/maintenance'
import Link from 'next/link'
import { EmergencyDetailsForm } from '@/components/portal/maintenance/emergency-details-form.tsx'
import { submitEmergencyForm } from '@/lib/maintenance/actions.ts'
import { shutoffForEmergency, unitForEmergency } from '@/lib/maintenance/emergency.ts'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'

export const metadata = { title: 'Emergency' }

// MAINT-01's emergency intake (R-020).
//
// Every category's shutoff is resolved HERE, on the server, before the page
// renders - not fetched when the tenant picks one. A tenant standing in
// rising water must not wait on a round trip to be told where their stop tap
// is, and this is a handful of small indexed lookups against one unit.

interface ShutoffInfo {
  type: string
  description: string | null
  photoDocumentId: string | null
}

const SHUTOFF_WORDS: Record<string, string> = {
  WATER_MAIN: 'Your water shutoff',
  BREAKER_PANEL: 'Your breaker panel',
  GAS: 'Your gas shutoff',
  OTHER: 'Your shutoff',
}

export default async function EmergencyPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; ready?: string }>
}) {
  const { c, ready } = await searchParams
  // THE CHOSEN CATEGORY LIVES IN THE URL (R-098).
  //
  // It was `useState` before, which meant the safety instructions - the
  // highest-stakes text in this product - did not exist until React
  // hydrated. A tenant who could smell gas on a weak connection tapped a
  // category and got nothing. Now the category list is server-rendered
  // links, and choosing one is a navigation: the instructions arrive as
  // HTML, the back button works, the screen is deep-linkable, and a screen
  // reader announces the new page without any focus management.
  const category = c && isEmergencyCategory(c) ? c : null
  // The questions live behind a second URL so the safety instructions come
  // first and alone - see the comment where they are rendered.
  const showDetails = category !== null && ready === '1'

  const { scope } = await requireTenantWithScope()
  const home = await unitForEmergency(scope)

  if (!home) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Emergency</h1>
        <p>
          We do not have a home on file for you yet, so we cannot route this
          to the right person. Please call 911 if anyone is in danger, then
          call or text the number on your lease.
        </p>
      </div>
    )
  }

  const resolved = await Promise.all(
    EMERGENCY_CATEGORIES.map(
      async (category) =>
        [category, await shutoffForEmergency(home.unitId, category)] as const,
    ),
  )
  const shutoffs: Partial<Record<EmergencyCategory, ShutoffInfo>> = {}
  for (const [category, shutoff] of resolved) {
    if (shutoff) shutoffs[category] = shutoff
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Emergency</h1>
        {/*
          Said before anything else on the page, and not only inside a
          category's own instructions: somebody who lands here by accident,
          or whose situation is not on the list, still needs to read it.
        */}
        <p className="rounded-md border-2 border-red-600 bg-red-50 px-4 py-3 font-medium text-red-950 dark:bg-red-950 dark:text-red-50">
          If anyone is in danger, call 911 first. This page does not reach
          emergency services.
        </p>
      </div>

      {category === null ? (
        <nav aria-labelledby="what-is-happening" className="flex flex-col gap-3">
          <h2 id="what-is-happening" className="text-lg font-semibold">
            What is happening right now?
          </h2>
          <ul className="flex flex-col gap-2">
            {EMERGENCY_CATEGORIES.map((value) => (
              <li key={value}>
                {/* A LINK, not a button with a handler. One tap, no
                    confirm step, and it works before any JavaScript runs. */}
                <Link
                  href={`/portal/maintenance/emergency?c=${value}`}
                  className="focus-visible:ring-ring flex min-h-14 w-full items-center rounded-md border-2 border-red-600 bg-red-50 px-4 py-3 text-left text-base font-medium text-red-950 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none dark:bg-red-950 dark:text-red-50"
                >
                  {EMERGENCY_DEFINITIONS[value].label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : (
        <>
          <section
            aria-labelledby="do-now"
            className="flex flex-col gap-3 rounded-md border-2 border-red-600 bg-red-50 p-4 dark:bg-red-950"
          >
            <h2 id="do-now" className="text-lg font-semibold text-red-950 dark:text-red-50">
              Do this now
            </h2>
            <ol className="flex list-decimal flex-col gap-2 pl-5 text-red-950 dark:text-red-50">
              {EMERGENCY_DEFINITIONS[category].selfProtection.map((instruction) => (
                <li key={instruction}>{instruction}</li>
              ))}
            </ol>
          </section>

          {EMERGENCY_DEFINITIONS[category].shutoffType && (
            <section aria-labelledby="shutoff" className="flex flex-col gap-2">
              <h2 id="shutoff" className="text-lg font-semibold">
                {SHUTOFF_WORDS[EMERGENCY_DEFINITIONS[category].shutoffType!] ?? 'Your shutoff'}
              </h2>
              {shutoffs[category]?.description ? (
                <p>{shutoffs[category]!.description}</p>
              ) : (
                // Honest rather than empty: a tenant who reads "we do not
                // have this on file" knows to stop looking and call.
                <p>
                  We do not have this recorded for your home yet. If you cannot
                  find it safely, do not keep looking — call us.
                </p>
              )}
              {shutoffs[category]?.photoDocumentId && (
                <a
                  href={`/api/documents/${shutoffs[category]!.photoDocumentId}/file`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:bg-accent focus-visible:ring-ring flex min-h-12 w-fit items-center rounded-md border px-4 py-2 underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                >
                  See the photo
                </a>
              )}
            </section>
          )}

          <p>
            When you are safe, send this to us and we will wake someone up.
            You can also call or text the number on your lease.
          </p>

          {/* TWO STEPS, and the order is the point. R-020: "a tenant who
              can smell gas should read 'leave now, then call 911' before
              they read anything else, and certainly before they spend
              thirty seconds answering questions for us." The questions are
              behind this link, not beside the instructions. */}
          {showDetails ? (
            <EmergencyDetailsForm
              category={category}
              categoryLabel={EMERGENCY_DEFINITIONS[category].label}
              action={submitEmergencyForm}
            />
          ) : (
            <Link
              href={`/portal/maintenance/emergency?c=${category}&ready=1`}
              className="bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-12 w-fit items-center justify-center rounded-md px-6 py-2 text-base font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              Continue
            </Link>
          )}

          <Link
            href="/portal/maintenance/emergency"
            className="focus-visible:ring-ring w-fit rounded-md underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
          >
            This is not what is happening — go back
          </Link>
        </>
      )}

      <p>
        Not an emergency?{' '}
        <Link
          href="/portal/maintenance/new"
          className="focus-visible:ring-ring rounded-md underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          Report an ordinary problem instead
        </Link>
        .
      </p>
    </div>
  )
}
