import { AuthCard } from '@/components/auth-form.tsx'
import { PRIMARY_BUTTON_CLASSES } from '@/components/ui-classes.ts'

// The page a magic link lands on. It changes nothing: the token is spent by
// the POST behind the button, so a mail scanner that fetches this URL costs
// the tenant nothing (K1). A real `<form method="post">`, not an onClick -
// it must work on first paint, before hydration.
export function MagicLinkConfirm({
  token,
  action,
  title,
  description,
}: {
  token: string
  action: string
  title: string
  description: string
}) {
  return (
    <AuthCard title={title} description={description}>
      <form method="post" action={action} className="flex flex-col gap-5">
        <input type="hidden" name="token" value={token} />
        <button type="submit" className={PRIMARY_BUTTON_CLASSES}>
          Continue
        </button>
      </form>
    </AuthCard>
  )
}
