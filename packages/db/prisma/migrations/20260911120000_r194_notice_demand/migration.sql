-- ---------------------------------------------------------------------------
-- R-194: a cure notice records what it demanded.
--
-- `Notice` held no amount, so whether a tenant cured was read by eye. Both
-- new columns are set at INSERT by the drafting action and are deliberately
-- NOT added to `notice_guard()`'s write-once list (R-161): the trigger's
-- jsonb diff already refuses any change to a column outside that list, which
-- is exactly the guarantee a demand needs. Adding a column does not fire the
-- row trigger, so existing notices simply read null - "not recorded".
-- ---------------------------------------------------------------------------

ALTER TABLE "Notice"
  ADD COLUMN "demandedCents" INTEGER,
  ADD COLUMN "demandComposition" JSONB;

-- A total with no lines behind it, or lines with no total, is a demand nobody
-- can check. And a notice demanding nothing is not a cure notice.
ALTER TABLE "Notice"
  ADD CONSTRAINT "Notice_demand_shape"
  CHECK (
    ("demandedCents" IS NULL) = ("demandComposition" IS NULL)
    AND ("demandedCents" IS NULL OR "demandedCents" > 0)
  );

-- Three-valued like "acceptanceWaivesNotice": null is "nobody has reviewed
-- this state", never "no". No state is seeded with a stance.
ALTER TABLE "JurisdictionRule"
  ADD COLUMN "cureDemandMayIncludeFees" BOOLEAN,
  ADD COLUMN "partialPaymentCures" BOOLEAN;
