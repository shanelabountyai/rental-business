-- A platform fee handed back, from `application_fee.refunded`. Its own rows,
-- one per Stripe fee refund: PlatformFee is append-only, so a refund is a new
-- fact, never an edit to the fee. Written only by the Stripe pipeline (D-11).
CREATE TABLE "PlatformFeeRefund" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "stripeFeeRefundId" TEXT NOT NULL,
    "stripeApplicationFeeId" TEXT NOT NULL,
    "stripeAccountId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformFeeRefund_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformFeeRefund_orgId_stripeFeeRefundId_key" ON "PlatformFeeRefund"("orgId", "stripeFeeRefundId");

ALTER TABLE "PlatformFeeRefund" ADD CONSTRAINT "PlatformFeeRefund_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only, as every money fact is.
CREATE TRIGGER "PlatformFeeRefund_append_only"
  BEFORE UPDATE OR DELETE ON "PlatformFeeRefund"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "PlatformFeeRefund_no_truncate"
  BEFORE TRUNCATE ON "PlatformFeeRefund"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- ORG-06: named by the writer (the fee's org) and never moves.
CREATE TRIGGER org_scope BEFORE UPDATE OF "orgId" ON "PlatformFeeRefund" FOR EACH ROW EXECUTE FUNCTION org_scope();

ALTER TABLE "PlatformFeeRefund" ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "PlatformFeeRefund" TO rental_rls
  USING ("orgId" = current_setting('app.org_id', true))
  WITH CHECK ("orgId" = current_setting('app.org_id', true));
