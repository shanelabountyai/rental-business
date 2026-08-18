-- R-061 (LEASE-05): FCRA adverse action - generated on any decline or
-- approve-with-conditions citing a consumer report, delivery logged on the
-- same Notice/NoticeDelivery machinery every other legal notice uses
-- (R-051), and it blocks the pipeline from advancing to APPROVED/SIGNED
-- until sent or overridden with a logged reason.

-- AlterTable: Notice now addresses EITHER a Lease OR an Applicant, never
-- both and never neither (CHECK below) - an FCRA notice goes to someone
-- with no tenancy yet.
ALTER TABLE "Notice" ADD COLUMN "applicantId" TEXT;
ALTER TABLE "Notice" ALTER COLUMN "leaseId" DROP NOT NULL;

ALTER TABLE "Notice" ADD CONSTRAINT "Notice_lease_xor_applicant_check"
  CHECK (("leaseId" IS NOT NULL) <> ("applicantId" IS NOT NULL));

-- CreateIndex
CREATE INDEX "Notice_applicantId_idx" ON "Notice"("applicantId");

-- AddForeignKey. RESTRICT, matching leaseId's own original FK (the existing
-- constraint is untouched by the ALTER COLUMN above - dropping NOT NULL
-- does not require dropping and recreating it).
ALTER TABLE "Notice" ADD CONSTRAINT "Notice_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: ScreeningReport carries the reporting agency's own identity
-- (frozen at order time, like criteriaVersion) and the adverse-action
-- compliance block's state.
ALTER TABLE "ScreeningReport" ADD COLUMN "agencyContact" TEXT;
ALTER TABLE "ScreeningReport" ADD COLUMN "adverseActionNoticeId" TEXT;
ALTER TABLE "ScreeningReport" ADD COLUMN "adverseActionOverrideReason" TEXT;
ALTER TABLE "ScreeningReport" ADD COLUMN "adverseActionOverriddenAt" TIMESTAMP(3);
ALTER TABLE "ScreeningReport" ADD COLUMN "adverseActionOverriddenByStaffId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningReport_adverseActionNoticeId_key" ON "ScreeningReport"("adverseActionNoticeId");

-- AddForeignKey
ALTER TABLE "ScreeningReport" ADD CONSTRAINT "ScreeningReport_adverseActionNoticeId_fkey" FOREIGN KEY ("adverseActionNoticeId") REFERENCES "Notice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningReport" ADD CONSTRAINT "ScreeningReport_adverseActionOverriddenByStaffId_fkey" FOREIGN KEY ("adverseActionOverriddenByStaffId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
