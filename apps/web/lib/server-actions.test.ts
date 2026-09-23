import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Every export of a 'use server' module is a public endpoint (SEC-01). A
// helper that takes a bare id and trusts it - `markNoticeRead(noticeId,
// leaseIds)` was the sharpest case, a forgeable proof of portal service -
// belongs in a plain module, not beside the actions that call it.
//
// STATIC, NOT A CALL. Calling 260 exports anonymously with made-up arguments
// proves little about any one of them. This instead refuses any export whose
// body (or a local function it calls) reaches no session guard, unless it is
// named below with the reason it may be public. A new unguarded export fails
// here until somebody writes that reason down or moves it out.
//
// ponytail: regex, not an AST - a guard inside a comment would satisfy it.
// It catches the forgotten case, which is the one that shipped.

const ROOT = join(__dirname, '..')
const GUARD = /\b(require[A-Z]\w*|auth|signIn|signOut)\(/

const PUBLIC_BY_DESIGN: Record<string, string> = {
  'lib/vendors/bid-actions.ts#submitBid': 'vendor token (verifyBidLink)',
  'lib/vendors/actions.ts#respondToWorkOrder': 'vendor token (verifyVendorLink)',
  'lib/vendors/actions.ts#revealCodeForVendor': 'vendor token (verifyVendorLink)',
  'lib/vendors/actions.ts#uploadVendorDocument': 'vendor token (verifyVendorLink)',
  'lib/vendors/actions.ts#markWorkComplete': 'vendor token (verifyVendorLink)',
  'lib/vendors/actions.ts#sendVendorMessage': 'vendor token (verifyVendorLink)',
  'lib/payments/actions.ts#startPaymentFromLink': 'pay token (verifyPayLink)',
  'lib/payments/plan-actions.ts#sendPaymentPlanForSignature': 'guarded in plan-esign.ts',
  'lib/portal/verify-link-actions.ts#answerFromLink': 'verify token (verifyVerifyLink)',
  'lib/prospects/prescreen-actions.ts#submitPrescreenAnswers': 'prescreen token',
  'lib/prospects/actions.ts#submitInquiry': 'public listing inquiry, rate-limited',
  'lib/auth/actions.ts#requestPasswordReset': 'sign-in flow, rate-limited',
  'lib/auth/actions.ts#completePasswordReset': 'reset token (redeemToken)',
  'lib/auth/actions.ts#requestTenantMagicLink': 'sign-in flow, rate-limited',
  'lib/auth/actions.ts#requestGuarantorMagicLink': 'sign-in flow, rate-limited',
  'lib/showings/access-actions.ts#verifyIdentityForShowing': 'showing-access token',
  'lib/showings/actions.ts#bookShowing': 'showing-booking token',
  'lib/scope/actions.ts#selectScope': 'a preference cookie, intersected with RBAC on read',
  'lib/leases/party-change-actions.ts#startPartyChange': 'guarded in loadLeaseForPartyChange',
  'lib/leases/party-change-actions.ts#releaseGuarantor': 'guarded in loadLeaseForPartyChange',
  'lib/leases/party-change-actions.ts#voidPartyChange': 'guarded in loadLeaseForPartyChange',
  'lib/leases/esign-actions.ts#signLeaseDocument': 'signer token (verifySignerLink)',
  'lib/applications/actions.ts#submitApplicantForm': 'application token',
  'lib/applications/actions.ts#inviteCoApplicant': 'application token',
  'lib/applications/actions.ts#uploadApplicationDocument': 'application token, rate-limited',
  'lib/applications/actions.ts#startApplicationFeePayment': 'application token',
  'lib/maintenance/clarify-actions.ts#submitClarification': 'clarify token (applyClarification)',
  'lib/maintenance/clarify-actions.ts#submitClarificationForm': 'clarify token, via submitClarification',
  'lib/maintenance/clarify-actions.ts#uploadClarificationPhoto': 'clarify token (verifyClarifyLink)',
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

function unguardedExports(): string[] {
  const found: string[] = []
  for (const path of ['app', 'lib', 'components'].flatMap((d) => sourceFiles(join(ROOT, d)))) {
    const src = readFileSync(path, 'utf8')
    if (!/^['"]use server['"]/m.test(src)) continue
    const fns = [...src.matchAll(/^(export )?(?:async )?function (\w+)\s*\(/gm)].map((m, i, all) => ({
      exported: Boolean(m[1]),
      name: m[2],
      body: src.slice(m.index, all[i + 1]?.index ?? src.length),
    }))
    const guarded = new Set(fns.filter((fn) => GUARD.test(fn.body)).map((fn) => fn.name))
    for (let grew = true; grew; ) {
      grew = false
      for (const fn of fns) {
        if (guarded.has(fn.name)) continue
        if ([...guarded].some((g) => new RegExp(`\\b${g}\\(`).test(fn.body))) {
          guarded.add(fn.name)
          grew = true
        }
      }
    }
    const file = relative(ROOT, path)
    for (const fn of fns) {
      if (fn.exported && !guarded.has(fn.name)) found.push(`${file}#${fn.name}`)
    }
  }
  return found.sort()
}

describe("'use server' exports", () => {
  const found = unguardedExports()

  it('every unguarded export is public by design, with the reason written down', () => {
    expect(found.filter((key) => !(key in PUBLIC_BY_DESIGN))).toEqual([])
  })

  it('the allowlist names nothing that no longer exists', () => {
    expect(Object.keys(PUBLIC_BY_DESIGN).filter((key) => !found.includes(key))).toEqual([])
  })
})
