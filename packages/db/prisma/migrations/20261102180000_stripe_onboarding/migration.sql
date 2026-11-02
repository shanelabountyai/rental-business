-- R-277b (D-316, D-379): Stripe onboarding on a simulated adapter, and the
-- platform fee in its own append-only table.

-- 1. The simulated Stripe's own state (D-27). Org-less on purpose: it stands
--    in for the provider's database, keyed by Stripe's account id.
CREATE TABLE "SimulatedStripeAccount" (
    "accountId" TEXT NOT NULL,
    "detailsSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "chargesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "currentlyDue" TEXT[],
    "disabledReason" TEXT,
    "deauthorizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimulatedStripeAccount_pkey" PRIMARY KEY ("accountId")
);

-- 2. The platform fee. Not a LedgerEntry: every balance sums that table, and
--    this is the owner's cost, not the tenant's.
CREATE TABLE "PlatformFee" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "stripeApplicationFeeId" TEXT NOT NULL,
    "stripeAccountId" TEXT NOT NULL,
    "stripeChargeId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformFee_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformFee_orgId_stripeApplicationFeeId_key" ON "PlatformFee"("orgId", "stripeApplicationFeeId");

ALTER TABLE "PlatformFee" ADD CONSTRAINT "PlatformFee_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only, as LedgerEntry is: money facts are corrected by a new row.
CREATE TRIGGER "PlatformFee_append_only"
  BEFORE UPDATE OR DELETE ON "PlatformFee"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "PlatformFee_no_truncate"
  BEFORE TRUNCATE ON "PlatformFee"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- ORG-06: the org is named by the writer and never moves, as for
-- ProcessedStripeEvent, which also has no parent to derive it from.
CREATE TRIGGER org_scope BEFORE UPDATE OF "orgId" ON "PlatformFee" FOR EACH ROW EXECUTE FUNCTION org_scope();
