-- R-081b (RPT-07): the lender's Form 1098, recorded per loan per tax year.
--
-- Recorded, not reconciled: this product does not track mortgage payments, so
-- there is nothing to reconcile against. Schedule E line 12 reads this figure
-- and says on the page that it came from the 1098.

CREATE TABLE "MortgageAnnualStatement" (
  "id"                TEXT NOT NULL,
  "mortgageId"        TEXT NOT NULL,
  "taxYear"           INTEGER NOT NULL,
  "interestCents"     INTEGER NOT NULL,
  "principalCents"    INTEGER,
  "escrowCents"       INTEGER,
  "documentId"        TEXT,
  "recordedByStaffId" TEXT NOT NULL,
  "notes"             TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MortgageAnnualStatement_pkey" PRIMARY KEY ("id")
);

-- ONE 1098 PER LOAN PER YEAR. Two rows would double the interest on Schedule
-- E line 12 - an overstated deduction, not a tidiness problem.
CREATE UNIQUE INDEX "MortgageAnnualStatement_mortgageId_taxYear_key"
  ON "MortgageAnnualStatement"("mortgageId", "taxYear");

CREATE INDEX "MortgageAnnualStatement_taxYear_idx"
  ON "MortgageAnnualStatement"("taxYear");

ALTER TABLE "MortgageAnnualStatement"
  ADD CONSTRAINT "MortgageAnnualStatement_mortgageId_fkey"
  FOREIGN KEY ("mortgageId") REFERENCES "Mortgage"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MortgageAnnualStatement"
  ADD CONSTRAINT "MortgageAnnualStatement_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "Document"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MortgageAnnualStatement"
  ADD CONSTRAINT "MortgageAnnualStatement_recordedByStaffId_fkey"
  FOREIGN KEY ("recordedByStaffId") REFERENCES "StaffUser"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
