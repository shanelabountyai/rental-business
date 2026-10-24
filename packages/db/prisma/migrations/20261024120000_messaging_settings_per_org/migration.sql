-- R-285b follow-up: one MessagingSettings row per org, not one row in all.
--
-- R-266 made the table a singleton with CHECK ("id" = 'default'). R-285a moved
-- the singleton to @@unique([orgId]) but kept the check, and R-285b's save
-- creates a missing row with id = orgId - so the first save on a database with
-- no row yet (every fresh CI database, and org #0's own until somebody saved
-- once) failed the check and the page swallowed it as a server error. The
-- per-org unique is the rule now; the check only refuses rows it allows.
ALTER TABLE "MessagingSettings" DROP CONSTRAINT "MessagingSettings_singleton_check";
