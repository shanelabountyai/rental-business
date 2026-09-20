-- R-233: NotifyInput.urgent, persisted. Without it, scheduleRetry only knows
-- a Notification's category, so a provider bounce on an emergency dispatch
-- retried at the next quiet-hours-safe instant instead of immediately - see
-- the KNOWN GAP comment at apps/web/lib/notifications/send.ts's scheduleRetry.
ALTER TABLE "Notification" ADD COLUMN "urgent" BOOLEAN NOT NULL DEFAULT false;
