import { NotificationPreferencesSection } from '@/components/notifications/preferences-section.tsx'
import { setOwnGuarantorNotificationPreference } from '@/lib/notifications/actions.ts'
import { getPreferences } from '@/lib/notifications/queries.ts'
import { requireGuarantor } from '@/lib/portal/guarantor-guard.ts'

export const metadata = { title: 'Your account' }

// D-252: a guarantor's own say over how they are contacted. No autopay
// section here (unlike the tenant page this mirrors) - a guarantor pays
// nothing directly, so there is no debit day to pick. `getPreferences`
// already filters to only the categories GUARANTOR is in the audience for
// (rent_reminder, payment_plan, lease_signature, account_access), and all but
// rent_reminder are locked - see CATEGORY_AUDIENCE / LOCKED_CATEGORIES in
// packages/core/notifications/categories.ts.

export default async function GuarantorAccountPage() {
  const guarantor = await requireGuarantor()
  const preferences = await getPreferences('GUARANTOR', guarantor.id)

  return (
    <div className="flex w-full flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Your account</h1>
        <p className="text-muted-foreground text-base">
          {guarantor.name}
          {guarantor.email ? ` · ${guarantor.email}` : ''}
        </p>
      </header>

      <NotificationPreferencesSection
        preferences={preferences}
        action={setOwnGuarantorNotificationPreference}
      />
    </div>
  )
}
