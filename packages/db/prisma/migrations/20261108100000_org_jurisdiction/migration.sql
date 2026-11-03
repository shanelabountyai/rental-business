-- R-298a (PRD 10 §7.2, D-389): the states each org operates in, and its own
-- counsel's review of them. orgId immutable via org_scope(); no org default.
CREATE TABLE "OrgJurisdiction" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "counselReviewedBy" TEXT,
    "counselReviewedAt" DATE,

    CONSTRAINT "OrgJurisdiction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrgJurisdiction_counsel_both_or_neither"
      CHECK (("counselReviewedBy" IS NULL) = ("counselReviewedAt" IS NULL))
);

CREATE UNIQUE INDEX "OrgJurisdiction_orgId_state_key" ON "OrgJurisdiction"("orgId", "state");

ALTER TABLE "OrgJurisdiction" ADD CONSTRAINT "OrgJurisdiction_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER org_scope BEFORE UPDATE OF "orgId" ON "OrgJurisdiction" FOR EACH ROW EXECUTE FUNCTION org_scope();

-- Every state an org already has property in is enabled, counsel review
-- unrecorded: the owner states it, nothing here can (D-389).
INSERT INTO "OrgJurisdiction" ("id", "orgId", "state")
SELECT 'oj_' || md5("orgId" || ':' || "state"), "orgId", "state"
FROM (SELECT DISTINCT "orgId", "state" FROM "Property") AS places;

ALTER TABLE "OrgHealth" ADD COLUMN "enabledStates" TEXT[] DEFAULT ARRAY[]::TEXT[];
