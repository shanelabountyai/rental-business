-- R-282a (PRD 09 Q3-Q5, Q7; D-312, D-397, D-398): the onboarding mapping, the
-- planned journals and the per-ledger-entry sync state. orgId is derived from
-- the connection by org_scope() and never changes.
-- CreateEnum
CREATE TYPE "QuickBooksMappingKind" AS ENUM ('ACCOUNT', 'PROPERTY');

-- AlterTable
ALTER TABLE "QuickBooksConnection" ADD COLUMN     "lastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "syncProblem" TEXT;

-- CreateTable
CREATE TABLE "QuickBooksMapping" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "kind" "QuickBooksMappingKind" NOT NULL,
    "platformKey" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuickBooksMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuickBooksJournal" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "propertyId" TEXT NOT NULL,
    "txnDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "externalId" TEXT,
    "lastError" TEXT,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuickBooksJournal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuickBooksSyncLink" (
    "ledgerEntryId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "journalId" TEXT,
    "excludedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuickBooksSyncLink_pkey" PRIMARY KEY ("ledgerEntryId")
);

-- CreateIndex
CREATE INDEX "QuickBooksMapping_orgId_idx" ON "QuickBooksMapping"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksMapping_connectionId_kind_platformKey_key" ON "QuickBooksMapping"("connectionId", "kind", "platformKey");

-- CreateIndex
CREATE UNIQUE INDEX "QuickBooksJournal_number_key" ON "QuickBooksJournal"("number");

-- CreateIndex
CREATE INDEX "QuickBooksJournal_connectionId_status_idx" ON "QuickBooksJournal"("connectionId", "status");

-- CreateIndex
CREATE INDEX "QuickBooksJournal_orgId_idx" ON "QuickBooksJournal"("orgId");

-- CreateIndex
CREATE INDEX "QuickBooksSyncLink_journalId_idx" ON "QuickBooksSyncLink"("journalId");

-- CreateIndex
CREATE INDEX "QuickBooksSyncLink_connectionId_idx" ON "QuickBooksSyncLink"("connectionId");

-- CreateIndex
CREATE INDEX "QuickBooksSyncLink_orgId_idx" ON "QuickBooksSyncLink"("orgId");

-- AddForeignKey
ALTER TABLE "QuickBooksMapping" ADD CONSTRAINT "QuickBooksMapping_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickBooksMapping" ADD CONSTRAINT "QuickBooksMapping_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "QuickBooksConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickBooksJournal" ADD CONSTRAINT "QuickBooksJournal_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickBooksJournal" ADD CONSTRAINT "QuickBooksJournal_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "QuickBooksConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickBooksJournal" ADD CONSTRAINT "QuickBooksJournal_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickBooksSyncLink" ADD CONSTRAINT "QuickBooksSyncLink_ledgerEntryId_fkey" FOREIGN KEY ("ledgerEntryId") REFERENCES "LedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickBooksSyncLink" ADD CONSTRAINT "QuickBooksSyncLink_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickBooksSyncLink" ADD CONSTRAINT "QuickBooksSyncLink_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "QuickBooksConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickBooksSyncLink" ADD CONSTRAINT "QuickBooksSyncLink_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "QuickBooksJournal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Exactly one: posted in a journal, or excluded with a reason.
ALTER TABLE "QuickBooksSyncLink" ADD CONSTRAINT "QuickBooksSyncLink_journal_xor_excluded"
  CHECK (("journalId" IS NULL) <> ("excludedReason" IS NULL));

-- A link IS the record that an entry reached the books. Deleting one would
-- make the next sync post it again, which is a duplicate in somebody's
-- company file, so links are append-only like the ledger they point at.
CREATE TRIGGER "QuickBooksSyncLink_append_only"
  BEFORE UPDATE OR DELETE ON "QuickBooksSyncLink"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER "QuickBooksSyncLink_no_truncate"
  BEFORE TRUNCATE ON "QuickBooksSyncLink"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "connectionId" ON "QuickBooksMapping" FOR EACH ROW EXECUTE FUNCTION org_scope('QuickBooksConnection', 'connectionId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "connectionId", "propertyId" ON "QuickBooksJournal" FOR EACH ROW EXECUTE FUNCTION org_scope('QuickBooksConnection', 'connectionId', 'Property', 'propertyId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "connectionId", "ledgerEntryId", "journalId" ON "QuickBooksSyncLink" FOR EACH ROW EXECUTE FUNCTION org_scope('QuickBooksConnection', 'connectionId', 'LedgerEntry', 'ledgerEntryId', 'QuickBooksJournal', 'journalId');

-- R-287a's backstop, as every org-owned table has it.
ALTER TABLE "QuickBooksMapping" ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "QuickBooksMapping" TO rental_rls
  USING ("orgId" = current_setting('app.org_id', true))
  WITH CHECK ("orgId" = current_setting('app.org_id', true));
ALTER TABLE "QuickBooksJournal" ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "QuickBooksJournal" TO rental_rls
  USING ("orgId" = current_setting('app.org_id', true))
  WITH CHECK ("orgId" = current_setting('app.org_id', true));
ALTER TABLE "QuickBooksSyncLink" ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "QuickBooksSyncLink" TO rental_rls
  USING ("orgId" = current_setting('app.org_id', true))
  WITH CHECK ("orgId" = current_setting('app.org_id', true));
