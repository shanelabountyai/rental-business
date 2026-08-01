-- CreateEnum
CREATE TYPE "JobRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "propertyId" TEXT,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventConsumption" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "consumer" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventConsumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "propertyId" TEXT,
    "businessDate" DATE NOT NULL,
    "status" "JobRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "result" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_occurredAt_idx" ON "OutboxEvent"("publishedAt", "occurredAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_aggregateType_aggregateId_idx" ON "OutboxEvent"("aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "OutboxEvent_propertyId_idx" ON "OutboxEvent"("propertyId");

-- CreateIndex
CREATE INDEX "EventConsumption_consumer_idx" ON "EventConsumption"("consumer");

-- CreateIndex
CREATE UNIQUE INDEX "EventConsumption_eventId_consumer_key" ON "EventConsumption"("eventId", "consumer");

-- CreateIndex
CREATE INDEX "JobRun_jobType_businessDate_idx" ON "JobRun"("jobType", "businessDate");

-- CreateIndex
CREATE INDEX "JobRun_propertyId_businessDate_idx" ON "JobRun"("propertyId", "businessDate");

-- CreateIndex
CREATE INDEX "JobRun_status_idx" ON "JobRun"("status");

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventConsumption" ADD CONSTRAINT "EventConsumption_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "OutboxEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Job idempotency.
--
-- One run per (job, property, local business day). This is what turns an
-- hourly cron plus a due check that stays true for the rest of the day into a
-- job that executes exactly once - and what makes the fall-back DST hour, when
-- 01:00 happens twice, produce one run instead of two sets of charges.
--
-- COALESCE for the same reason R-004's assignment index needed it: NULL never
-- equals NULL in a unique index, so without it every portfolio-wide job -
-- propertyId IS NULL - would be entirely unconstrained and could run on every
-- single tick. That is the most damaging case, not the least.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "JobRun_one_run_per_local_day"
  ON "JobRun" ("jobType", COALESCE("propertyId", ''), "businessDate");
