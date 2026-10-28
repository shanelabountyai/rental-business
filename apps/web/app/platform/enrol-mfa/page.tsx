import { AuthCard } from '@/components/auth-form.tsx'
import { MfaEnrolment } from '@/components/mfa-enrolment.tsx'
import {
  beginPlatformMfaEnrolment,
  confirmPlatformMfaEnrolment,
} from '@/lib/platform/auth-actions.ts'

// Public (PUBLIC_ROUTES): before any session exists (PADM-02). The challenge
// cookie is the credential, and both actions refuse without one or once the
// admin is already enrolled.
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Set up two-factor authentication' }

export default function PlatformEnrolMfaPage() {
  return (
    <AuthCard
      title="Set up two-factor authentication"
      description="The platform console requires an authenticator app. You cannot continue without one."
    >
      <MfaEnrolment
        enrolled={false}
        begin={beginPlatformMfaEnrolment}
        confirm={confirmPlatformMfaEnrolment}
        continueHref="/platform"
      />
    </AuthCard>
  )
}
