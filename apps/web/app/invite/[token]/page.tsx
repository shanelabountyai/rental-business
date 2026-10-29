import { MIN_PASSWORD_LENGTH, hashToken } from '@rental/core/auth'
import { INVITE_REFUSED, inviteRefusal } from '@rental/core/rbac'
import { prisma } from '@rental/db'
import { AuthCard, AuthForm, Field } from '@/components/auth-form.tsx'
import { acceptOrgInvite } from '@/lib/auth/invite-actions.ts'
import { hostOrgId } from '@/lib/auth/org.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Accept your invitation' }

// PRD 11 §4.17 (R-304a). Changes nothing on GET; the press spends the token.
// Every invite it will not honour reads the same sentence (§6).
export default async function AcceptInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const orgId = await hostOrgId()
  const invite = await prisma.orgInvite.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { organization: { select: { name: true } } },
  })
  if (inviteRefusal(invite, orgId) || !invite) {
    return (
      <AuthCard title="That invitation cannot be used">
        <p className="text-sm">{INVITE_REFUSED}</p>
      </AuthCard>
    )
  }
  const existing = await prisma.staffUser.findUnique({ where: { email: invite.email }, select: { id: true } })

  return (
    <AuthCard
      title={`Join ${invite.organization.name}`}
      description={
        existing
          ? `You are invited as ${invite.email}, which already has an account. Accept, then sign in with your existing password.`
          : `You are invited as ${invite.email}. Choose a password of at least ${MIN_PASSWORD_LENGTH} characters; a memorable phrase beats a short password with symbols in it.`
      }
    >
      <AuthForm action={acceptOrgInvite} submitLabel={existing ? 'Accept and join' : 'Set password and join'}>
        {/* Server actions do not see the URL, so the token rides in the form. */}
        <input type="hidden" name="token" value={token} />
        {!existing && (
          <>
            <Field label="Password" name="password" type="password" autoComplete="new-password" autoFocus />
            <Field label="Confirm password" name="confirmPassword" type="password" autoComplete="new-password" />
          </>
        )}
      </AuthForm>
    </AuthCard>
  )
}
