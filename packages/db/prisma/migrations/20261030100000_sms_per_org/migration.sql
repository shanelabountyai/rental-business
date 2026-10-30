-- R-292a (PRD 10 §3.2, §3.3): SMS routing and opt-out belong to an org.

-- 1. An opt-out is (org, phone). With `phone` unique on its own, STOP to org
--    A's number silenced org B's texts to the same person. Every row so far
--    is org #0's, so the new key cannot collide. The default goes too: a
--    writer that forgot the org would otherwise file the STOP in org #0 and
--    leave the org it was sent to texting them. `SmsOptOut_orgId_idx` is
--    redundant under the new key's leading column.
ALTER TABLE "SmsOptOut" ALTER COLUMN "orgId" DROP DEFAULT;
DROP INDEX "SmsOptOut_phone_key";
DROP INDEX "SmsOptOut_orgId_idx";
CREATE UNIQUE INDEX "SmsOptOut_orgId_phone_key" ON "SmsOptOut"("orgId", "phone");

-- 2. An unrouted message lands in the queue of the org whose number it was
--    sent to. org_scope derives the org only once it is filed into a thread,
--    so on insert the writer must name it.
ALTER TABLE "UnroutedMessage" ALTER COLUMN "orgId" DROP DEFAULT;

-- 3. One number, one org. Inbound looks the org up by `To` before it can
--    verify the signature, so two rows holding the same number would hand
--    a forger the choice of which token to sign with. An expression index,
--    because Prisma cannot express a unique over a JSON key.
CREATE UNIQUE INDEX "OrgIntegration_twilio_number"
  ON "OrgIntegration" (("config" ->> 'phoneNumber'))
  WHERE "provider" = 'TWILIO';
