-- R-213: serving a cure notice can stop the late-fee meter.
--
-- A new hold TYPE, not a column: the effects follow from the type in
-- packages/core/holds, and the nightly late-fee job already skips any lease
-- whose active holds claim `halt_late_fees`. Nothing else here changes.
ALTER TYPE "LeaseHoldType" ADD VALUE 'NOTICE_SERVED';

-- Picked up while this item needed a migration anyway (R-209/R-210/R-211's
-- handoff). `Notification.eventId` references `OutboxEvent` with no index, so
-- every `outboxEvent.deleteMany` in a test teardown seq-scanned the whole
-- table per deleted event.
CREATE INDEX "Notification_eventId_idx" ON "Notification"("eventId");
