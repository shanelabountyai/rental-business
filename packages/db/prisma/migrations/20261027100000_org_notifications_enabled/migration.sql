-- R-290b: the per-org notification kill switch (PRD 10 §M5). Read beside the
-- global NOTIFICATIONS_ENABLED, which stays as the platform-wide switch: one
-- that needs the database cannot stop a database incident. Defaults on, for
-- the same reason the env var does - a missing value meaning "off" is a
-- silent outage.
ALTER TABLE "Organization" ADD COLUMN "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true;
