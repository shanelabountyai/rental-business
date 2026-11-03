-- R-298b (PRD 10 §7.2, D-390): an org's own policy, stricter only. Null is
-- "no policy" - the statute governs alone. `rulesFor` takes the stricter of
-- statute and policy, so a looser number here simply has no effect.
ALTER TABLE "OrgJurisdiction"
  ADD COLUMN "policyGraceDays" INTEGER,
  ADD COLUMN "policyLateFeeMaxCents" INTEGER,
  ADD COLUMN "policyEntryNoticeHours" INTEGER,
  ADD CONSTRAINT "OrgJurisdiction_policy_non_negative" CHECK (
    ("policyGraceDays" IS NULL OR "policyGraceDays" >= 0) AND
    ("policyLateFeeMaxCents" IS NULL OR "policyLateFeeMaxCents" >= 0) AND
    ("policyEntryNoticeHours" IS NULL OR "policyEntryNoticeHours" >= 0)
  );
