-- R-277a (D-316, D-378): Stripe ids are unique per ACCOUNT, not globally, so
-- every unique keyed on one moves under the org that owns the account.

-- 1. The webhook claim. D-24's claim-before-project insert keeps working on
--    the composite key. The default goes: the route resolves the org from
--    `event.account` before it claims, so an insert that names none is a bug.
ALTER TABLE "ProcessedStripeEvent" DROP CONSTRAINT "ProcessedStripeEvent_pkey";
ALTER TABLE "ProcessedStripeEvent" ADD CONSTRAINT "ProcessedStripeEvent_pkey" PRIMARY KEY ("orgId", "stripeEventId");
ALTER TABLE "ProcessedStripeEvent" ALTER COLUMN "orgId" DROP DEFAULT;

-- 2. Customer, subscription and intent ids, per org (PRD 10 §1.2).
DROP INDEX "LeasePayer_stripeCustomerId_key";
DROP INDEX "LeasePayer_stripeSubscriptionId_key";
CREATE UNIQUE INDEX "LeasePayer_orgId_stripeCustomerId_key" ON "LeasePayer"("orgId", "stripeCustomerId");
CREATE UNIQUE INDEX "LeasePayer_orgId_stripeSubscriptionId_key" ON "LeasePayer"("orgId", "stripeSubscriptionId");
DROP INDEX "Payment_stripePaymentIntentId_key";
CREATE UNIQUE INDEX "Payment_orgId_stripePaymentIntentId_key" ON "Payment"("orgId", "stripePaymentIntentId");

-- 3. One connected account, one org. The Connect webhook looks the org up by
--    `event.account`, so two rows naming the same account would project one
--    org's rent into another's ledger. Expression index, as for the Twilio
--    number (Prisma cannot express a unique over a JSON key).
CREATE UNIQUE INDEX "OrgIntegration_stripe_account"
  ON "OrgIntegration" (("config" ->> 'accountId'))
  WHERE "provider" = 'STRIPE';
