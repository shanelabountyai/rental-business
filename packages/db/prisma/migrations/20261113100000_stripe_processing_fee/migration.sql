-- R-282b (PRD 09 Q8, D-398): the fee Stripe kept from each payment, read from
-- its balance transaction. Never a LedgerEntry: the landlord's cost, not the
-- tenant's. orgId is derived from the payment by org_scope() and never changes.
-- CreateTable
CREATE TABLE "StripeProcessingFee" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "stripeBalanceTransactionId" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StripeProcessingFee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StripeProcessingFee_paymentId_key" ON "StripeProcessingFee"("paymentId");

-- CreateIndex
CREATE INDEX "StripeProcessingFee_orgId_idx" ON "StripeProcessingFee"("orgId");

-- AddForeignKey
ALTER TABLE "StripeProcessingFee" ADD CONSTRAINT "StripeProcessingFee_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StripeProcessingFee" ADD CONSTRAINT "StripeProcessingFee_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A fee is Stripe's fact about money that moved; a correction is Stripe's
-- to make, so the row is never edited.
CREATE TRIGGER "StripeProcessingFee_append_only"
  BEFORE UPDATE OR DELETE ON "StripeProcessingFee"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER "StripeProcessingFee_no_truncate"
  BEFORE TRUNCATE ON "StripeProcessingFee"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "paymentId" ON "StripeProcessingFee" FOR EACH ROW EXECUTE FUNCTION org_scope('Payment', 'paymentId');

ALTER TABLE "StripeProcessingFee" ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "StripeProcessingFee" TO rental_rls
  USING ("orgId" = current_setting('app.org_id', true))
  WITH CHECK ("orgId" = current_setting('app.org_id', true));
