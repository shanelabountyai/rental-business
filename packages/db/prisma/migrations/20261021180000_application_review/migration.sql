-- R-269 (PRD 08 C1, C3, C7): the decline-reason list, the reason and the
-- template version on each decision, and "request more info".

CREATE TABLE "DecisionReason" (
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "DecisionReason_pkey" PRIMARY KEY ("code")
);

-- PLACEHOLDER wording, not reviewed by counsel (OQ-16). Each names a written
-- screening criterion or the application itself, never a person's traits.
INSERT INTO "DecisionReason" ("code", "label") VALUES
    ('INCOME_BELOW_CRITERIA', 'Income below the written screening criteria'),
    ('CREDIT_BELOW_CRITERIA', 'Credit history below the written screening criteria'),
    ('RENTAL_HISTORY', 'Eviction or rental history, after individualized assessment'),
    ('CRIMINAL_HISTORY', 'Criminal history, after individualized assessment'),
    ('UNVERIFIED_INFORMATION', 'Application information could not be verified');

ALTER TABLE "ScreeningReport" ADD COLUMN "decisionReasonCode" TEXT,
ADD COLUMN "decisionTemplateVersion" TEXT;

ALTER TABLE "ScreeningReport" ADD CONSTRAINT "ScreeningReport_decisionReasonCode_fkey" FOREIGN KEY ("decisionReasonCode") REFERENCES "DecisionReason"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ApplicantInfoRequest" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "request" TEXT NOT NULL,
    "requestedByStaffId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicantInfoRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ApplicantInfoRequest_applicantId_idx" ON "ApplicantInfoRequest"("applicantId");

ALTER TABLE "ApplicantInfoRequest" ADD CONSTRAINT "ApplicantInfoRequest_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApplicantInfoRequest" ADD CONSTRAINT "ApplicantInfoRequest_requestedByStaffId_fkey" FOREIGN KEY ("requestedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
