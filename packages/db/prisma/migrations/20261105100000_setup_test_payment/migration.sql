-- R-291b (PRD 10 §5 step 9, D-384): the owner's $1 test invoice, paid. Its
-- own table, as PlatformFee is: LedgerEntry is the tenant's lease ledger and
-- the owner has no lease. Written only by the Stripe pipeline (D-11).
CREATE TABLE "SetupTestPayment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "stripeInvoiceId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SetupTestPayment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SetupTestPayment_orgId_stripeInvoiceId_key" ON "SetupTestPayment"("orgId", "stripeInvoiceId");

ALTER TABLE "SetupTestPayment" ADD CONSTRAINT "SetupTestPayment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only, as every money fact is.
CREATE TRIGGER "SetupTestPayment_append_only"
  BEFORE UPDATE OR DELETE ON "SetupTestPayment"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "SetupTestPayment_no_truncate"
  BEFORE TRUNCATE ON "SetupTestPayment"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- ORG-06: named by the writer (the event's org) and never moves.
CREATE TRIGGER org_scope BEFORE UPDATE OF "orgId" ON "SetupTestPayment" FOR EACH ROW EXECUTE FUNCTION org_scope();
