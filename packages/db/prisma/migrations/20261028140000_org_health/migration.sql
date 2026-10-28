-- R-303 (PRD 11 §5.5, D-354, D-368): the org's health as the console sees it,
-- written by the org's own cron children. Keyed by the org, so ORG-06 holds.

CREATE TABLE "OrgHealth" (
    "orgId" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "dailyAt" TIMESTAMP(3),
    "dailyOk" BOOLEAN,
    "notificationsAt" TIMESTAMP(3),
    "notificationsOk" BOOLEAN,
    "escalationsAt" TIMESTAMP(3),
    "escalationsOk" BOOLEAN,
    "failedRuns7d" INTEGER NOT NULL,
    "deadLetters" INTEGER NOT NULL,
    "queuedNotifications" INTEGER NOT NULL,
    "heldNotifications" INTEGER NOT NULL,
    "activeOwners" INTEGER NOT NULL,
    "activeMembers" INTEGER NOT NULL,
    "properties" INTEGER NOT NULL,
    "states" TEXT[],

    CONSTRAINT "OrgHealth_pkey" PRIMARY KEY ("orgId")
);

ALTER TABLE "OrgHealth" ADD CONSTRAINT "OrgHealth_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
