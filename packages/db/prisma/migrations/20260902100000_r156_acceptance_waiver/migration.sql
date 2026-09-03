-- R-156: whether accepting a payment after a cure notice is served waives the
-- notice is STATE LAW, so it lives here and never in code (D-4). NULL means
-- nobody has told us (D-48's posture) - the case page then warns
-- conservatively rather than answering for the state either way.
ALTER TABLE "JurisdictionRule"
  ADD COLUMN "acceptanceWaivesNotice" BOOLEAN,
  ADD COLUMN "acceptanceWaiverNote" TEXT;
