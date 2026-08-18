import { ApplicantForm } from '@/components/applications/applicant-form.tsx'
import { CoApplicantInviteForm } from '@/components/applications/coapplicant-invite-form.tsx'
import { DocumentUploadForm } from '@/components/applications/document-upload-form.tsx'
import { FeePayment } from '@/components/applications/fee-payment.tsx'
import {
  inviteCoApplicant,
  startApplicationFeePayment,
  submitApplicantForm,
  uploadApplicationDocument,
} from '@/lib/applications/actions.ts'
import { applicationLinkStatus } from '@/lib/applications/link.ts'
import { documentsForApplicant, householdFor } from '@/lib/applications/queries.ts'

export const metadata = {
  title: 'Your application',
  // Same rule as prescreen/[token], verify/[token] and pay/[token]: the URL
  // itself is the credential.
  robots: { index: false, follow: false },
}

// One adult's own application (LEASE-03, R-059).
//
// PUBLIC BY DESIGN: no session, no account - an applicant has neither. The
// token in the path is the entire credential and `applicationLinkStatus()`
// is the entire authorization, same shape as prescreen/[token] (R-058).
//
// UNLIKE prescreen/[token], this link stays live after submission -
// APPLICATION_LINK is multi-use (tokens.ts's own comment) - so there is no
// "already answered" rejection branch here. What changes is which SECTION
// of the page shows: the form while `!formSubmittedAt`, the fee payment
// step once submitted with a fee still due, and a plain confirmation once
// `completedAt` is set. The lead's co-applicant and document sections stay
// reachable throughout, because "come back anytime" is the entire point of
// a multi-use link.
export const dynamic = 'force-dynamic'

const REJECTION_MESSAGES: Record<string, string> = {
  not_found: 'This link is not valid.',
  wrong_purpose: 'This link is not valid.',
  wrong_subject: 'This link is not valid.',
  expired: 'This link has expired. Contact the office for a new one.',
}

export default async function ApplyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const status = await applicationLinkStatus(token)

  if (!status.ok) {
    return (
      <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">This link isn’t working</h1>
        <p className="text-base">{REJECTION_MESSAGES[status.reason] ?? 'This link is not valid.'}</p>
      </main>
    )
  }

  const { applicant } = status
  const feeDue = Boolean(applicant.feeCents && applicant.feeCents > 0 && !applicant.feePaidAt)
  const [household, documents] = await Promise.all([
    householdFor(applicant.applicationId),
    documentsForApplicant(applicant.id),
  ])

  return (
    <main className="mx-auto flex max-w-md flex-col gap-8 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Hi {applicant.firstName}, your application
        </h1>
        <p className="text-muted-foreground text-sm">
          Come back to this link anytime - your progress is saved as you go.
        </p>
      </header>

      {household.length > 1 && (
        <section aria-labelledby="household" className="flex flex-col gap-2">
          <h2 id="household" className="text-lg font-medium">
            Applying together
          </h2>
          <ul className="flex flex-col gap-1 text-sm">
            {household.map((member) => (
              <li key={member.id}>
                {member.firstName} {member.lastName}
                {member.isLead ? ' (started this application)' : ''} -{' '}
                {member.completedAt ? 'done' : 'in progress'}
              </li>
            ))}
          </ul>
        </section>
      )}

      {applicant.completedAt ? (
        <p role="status" className="rounded-md border p-4 text-base">
          Thanks - your section is complete. We’ll be in touch.
        </p>
      ) : (
        <>
          <section aria-labelledby="applicant-form">
            <h2 id="applicant-form" className="sr-only">
              Your information
            </h2>
            <ApplicantForm
              action={submitApplicantForm.bind(null, token)}
              values={{
                firstName: applicant.firstName,
                lastName: applicant.lastName,
                email: applicant.email,
                phone: applicant.phone,
                dateOfBirth: applicant.dateOfBirth
                  ? applicant.dateOfBirth.toISOString().slice(0, 10)
                  : null,
                currentAddressLine1: applicant.currentAddressLine1,
                currentCity: applicant.currentCity,
                currentState: applicant.currentState,
                currentPostalCode: applicant.currentPostalCode,
                monthsAtCurrentAddress: applicant.monthsAtCurrentAddress,
                employerName: applicant.employerName,
                monthlyIncomeCents: applicant.monthlyIncomeCents,
              }}
            />
          </section>

          {applicant.formSubmittedAt && feeDue && (
            <section aria-labelledby="fee" className="flex flex-col gap-2 border-t pt-6">
              <h2 id="fee" className="text-lg font-medium">
                Application fee
              </h2>
              <FeePayment
                publishableKey={process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? null}
                start={startApplicationFeePayment.bind(null, token)}
              />
            </section>
          )}
        </>
      )}

      <section aria-labelledby="documents" className="flex flex-col gap-3 border-t pt-6">
        <h2 id="documents" className="text-lg font-medium">
          Documents
        </h2>
        {documents.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {documents.map((doc) => (
              <li key={doc.id}>{doc.fileName}</li>
            ))}
          </ul>
        )}
        <DocumentUploadForm action={uploadApplicationDocument.bind(null, token)} />
      </section>

      {applicant.isLead && (
        <section aria-labelledby="coapplicants" className="flex flex-col gap-3 border-t pt-6">
          <h2 id="coapplicants" className="text-lg font-medium">
            Applying with someone else?
          </h2>
          <p className="text-muted-foreground text-sm">
            Add each adult 18 or older who will live here - they’ll get their own link.
          </p>
          <CoApplicantInviteForm action={inviteCoApplicant.bind(null, token)} />
        </section>
      )}
    </main>
  )
}
