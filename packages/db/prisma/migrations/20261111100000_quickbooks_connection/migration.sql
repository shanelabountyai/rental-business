-- R-280 (PRD 09 Q1, D-393 to D-396): one QuickBooks connection per legal
-- entity. orgId is derived from the entity by org_scope() and never changes.
CREATE TYPE "AccountingBasis" AS ENUM ('CASH', 'ACCRUAL');
CREATE TYPE "AccountingPropertyField" AS ENUM ('CLASS', 'LOCATION');

CREATE TABLE "QuickBooksConnection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "basis" "AccountingBasis" NOT NULL,
    "propertyField" "AccountingPropertyField" NOT NULL DEFAULT 'CLASS',
    "status" TEXT NOT NULL DEFAULT 'CONNECTING',
    "statusReason" TEXT,
    "realmId" TEXT,
    "secret" TEXT,
    "oauthStateHash" TEXT,
    "oauthStartedAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuickBooksConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "QuickBooksConnection_legalEntityId_key" ON "QuickBooksConnection"("legalEntityId");
CREATE UNIQUE INDEX "QuickBooksConnection_realmId_key" ON "QuickBooksConnection"("realmId");
CREATE UNIQUE INDEX "QuickBooksConnection_oauthStateHash_key" ON "QuickBooksConnection"("oauthStateHash");

ALTER TABLE "QuickBooksConnection" ADD CONSTRAINT "QuickBooksConnection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuickBooksConnection" ADD CONSTRAINT "QuickBooksConnection_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "legalEntityId" ON "QuickBooksConnection" FOR EACH ROW EXECUTE FUNCTION org_scope('LegalEntity', 'legalEntityId');

-- R-287a's backstop, as every org-owned table has it.
ALTER TABLE "QuickBooksConnection" ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "QuickBooksConnection" TO rental_rls
  USING ("orgId" = current_setting('app.org_id', true))
  WITH CHECK ("orgId" = current_setting('app.org_id', true));

-- The simulated Intuit's own records (D-27). Org-less, as Intuit's are.
CREATE TABLE "SimulatedQuickBooksGrant" (
    "id" TEXT NOT NULL,
    "realmId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "codeUsedAt" TIMESTAMP(3),
    "refreshToken" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimulatedQuickBooksGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SimulatedQuickBooksGrant_code_key" ON "SimulatedQuickBooksGrant"("code");
CREATE UNIQUE INDEX "SimulatedQuickBooksGrant_refreshToken_key" ON "SimulatedQuickBooksGrant"("refreshToken");
