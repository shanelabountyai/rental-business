-- R-175: a hold can be lifted by a job, not only by a person.
-- ==========================================================================
-- A HOLD CAN NOW BE LIFTED BY NOBODY, AND THE RECORD STILL HAS TO SAY WHO.
--
-- R-084's check constraint reads "a lift is three facts or none" - liftedAt,
-- liftedByStaffId and liftReason together - and it was right: a row with a
-- lift date and no reason cannot answer "on what basis did you resume
-- collecting from a bankrupt tenant". What it did not anticipate is a lift
-- that no person made. The payment-plan sweep lifts the hold because an
-- instalment date passed, and attributing that to whoever agreed the plan
-- would put a false fact on the one row an eviction is argued from.
--
-- So the requirement is unchanged in substance - a lifted hold always names
-- who lifted it and why - and only the vocabulary widens: the answer may now
-- be a job rather than a person, exactly as `AuditLog` has always allowed a
-- SYSTEM actor. Exactly one of the two is set, never both and never neither.
-- ==========================================================================

ALTER TABLE "LeaseHold" ADD COLUMN "liftedBySystem" TEXT;

ALTER TABLE "LeaseHold" DROP CONSTRAINT "LeaseHold_lift_is_complete";

ALTER TABLE "LeaseHold"
  ADD CONSTRAINT "LeaseHold_lift_is_complete"
  CHECK (
    ("liftedAt" IS NULL AND "liftedByStaffId" IS NULL AND "liftedBySystem" IS NULL AND "liftReason" IS NULL)
    OR (
      "liftedAt" IS NOT NULL
      AND "liftReason" IS NOT NULL
      AND ("liftedByStaffId" IS NULL) <> ("liftedBySystem" IS NULL)
    )
  );
