-- R-203 (PAY-08/LEASE-06, D-214): a tenant can e-sign the repayment plan
-- they were sent.
--
-- R-199 proves a plan was COMMUNICATED - the Notification rows carry the
-- whole schedule as it went out. Nothing recorded that the tenant AGREED,
-- and those are different facts: the first answers "we told you", the
-- second answers "you accepted these terms". A broken plan is argued from
-- the second.
--
-- NO NEW CEREMONY. The envelope, the per-signer links, the typed-name
-- signature and the completion certificate are R-063's, already shared with
-- R-090's amendment. A third kind is the whole mechanism.
--
-- THE SIGNATURE IS NEVER A CONDITION OF THE HOLD, which is why the column
-- below is nullable and why nothing here is NOT NULL. A plan agreed on the
-- phone at 4pm pauses the chase at 4pm; asking for a signature is the
-- operator's separate choice, taken afterwards or not at all. Making the
-- pause wait on a signature would reintroduce the exact harm R-175 exists
-- to prevent, wearing the opposite sign.

-- Cannot be USED in the same transaction that adds it (Postgres), and is
-- not: every write of this value is in application code.
ALTER TYPE "LeaseEnvelopeKind" ADD VALUE 'PAYMENT_PLAN';

-- On PaymentPlan rather than a `paymentPlanId` on LeaseEnvelope, the same
-- direction LeasePartyChange.envelopeId already points: the owning record
-- names the envelope it raised.
--
-- `ON DELETE RESTRICT`, like every other FK into LeaseEnvelope here. A
-- signed agreement is evidence; nothing may take it out from under the plan
-- it belongs to.
ALTER TABLE "PaymentPlan" ADD COLUMN "envelopeId" TEXT;

CREATE UNIQUE INDEX "PaymentPlan_envelopeId_key" ON "PaymentPlan"("envelopeId");

ALTER TABLE "PaymentPlan"
  ADD CONSTRAINT "PaymentPlan_envelopeId_fkey"
  FOREIGN KEY ("envelopeId") REFERENCES "LeaseEnvelope"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
