-- R-271 (PRD 08 C2): staff-only review notes on an applicant.

CREATE TABLE "ApplicantNote" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicantNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ApplicantNote_applicantId_idx" ON "ApplicantNote"("applicantId");

ALTER TABLE "ApplicantNote" ADD CONSTRAINT "ApplicantNote_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApplicantNote" ADD CONSTRAINT "ApplicantNote_authorStaffId_fkey" FOREIGN KEY ("authorStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
