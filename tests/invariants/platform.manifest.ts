// PLAT-02's manifest (PRD 11 §7.1, R-294c): every 'use server' export under
// lib/platform, keyed `<path under apps/web>#<export>`, with what it demands.
// `public` is a sign-in step that exists before any session, with the reason;
// `session` is `requirePlatform()`; `step-up` is `requirePlatform({ stepUp })`.
// `permission` (R-302a) is what `requirePlatform({ permission })` must demand:
// the suite drives the action as an admin holding no role and wants a refusal.
// An entry without one is an admin's own-account act. The suite fails on an
// export with no entry and an entry with no export.

import type { PlatformPermission } from '@rental/core/rbac'

export type PlatformEntry =
  | { public: string }
  | { guard: 'session' | 'step-up'; permission?: PlatformPermission }

export const platformManifest: Record<string, PlatformEntry> = {
  'lib/platform/auth-actions.ts#startPlatformSignIn': { public: 'the platform sign-in form' },
  'lib/platform/auth-actions.ts#completePlatformMfa': { public: 'second step of sign-in, gated by the challenge cookie' },
  'lib/platform/auth-actions.ts#beginPlatformMfaEnrolment': { public: 'enrolment before any session, gated by the challenge cookie' },
  'lib/platform/auth-actions.ts#confirmPlatformMfaEnrolment': { public: 'enrolment before any session, gated by the challenge cookie' },
  'lib/platform/auth-actions.ts#setPlatformPassword': { public: 'gated by the setup token in the form' },
  'lib/platform/auth-actions.ts#signOutOfPlatform': { public: 'clears only the caller’s own cookie' },
  'lib/platform/auth-actions.ts#completePlatformStepUp': { guard: 'session' },
  'lib/platform/auth-actions.ts#regeneratePlatformRecoveryCodes': { guard: 'step-up' },
  'lib/platform/auth-actions.ts#signOutOfPlatformEverywhere': { guard: 'session' },
  'lib/platform/admin-actions.ts#invitePlatformAdmin': { guard: 'step-up', permission: 'platformAdmin.manage' },
  'lib/platform/admin-actions.ts#managePlatformAdmin': { guard: 'step-up', permission: 'platformAdmin.manage' },
  'lib/platform/org-actions.ts#createOrganization': { guard: 'step-up', permission: 'org.create' },
  'lib/platform/org-actions.ts#manageOrgInvite': { guard: 'step-up', permission: 'org.create' },
  'lib/platform/org-actions.ts#configureOrganization': { guard: 'session', permission: 'org.configure' },
  'lib/platform/org-actions.ts#changeOrgSlug': { guard: 'step-up', permission: 'org.configure' },
  'lib/platform/org-actions.ts#switchOrgNotifications': { guard: 'step-up', permission: 'org.configure' },
  'lib/platform/job-actions.ts#rerunCronChild': { guard: 'session', permission: 'job.rerun' },
  'lib/platform/jurisdiction-actions.ts#createRuleVersion': { guard: 'step-up', permission: 'jurisdiction.publish' },
}
