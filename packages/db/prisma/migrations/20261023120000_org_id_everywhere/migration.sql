-- R-285a (D-317, D-318, D-339): orgId on every org-owned table.
--
-- Every row of an org-owned table now names its organisation, so the scope
-- change (R-285b), the cross-org harness (R-286) and RLS (R-287) can all check
-- the row they are on instead of joining to Property to find out.
--
-- The column is DERIVED, never trusted: the org_scope trigger copies it from
-- the row's first non-null org-owned parent and refuses any other parent that
-- sits in a different org. So a work order cannot name another org's vendor,
-- a message cannot land in another org's thread, and no writer has to know the
-- org at all. A row with no parent (Tenant, Vendor, the templates) takes what
-- it was given, today always the 'org_0' default. That default is the same
-- bridge as D-338's and R-301 removes it. orgId never changes once written.
--
-- Backfill: org #0 is the only organisation, so the DEFAULT stamps every
-- existing row in the ADD COLUMN itself. That is a metadata-only change in
-- Postgres 11+, which is why the append-only tables (no UPDATE allowed) can
-- take it.

-- Args are (parentTable, fkColumn) pairs, in priority order.
CREATE FUNCTION org_scope() RETURNS trigger AS $$
DECLARE
  rec jsonb := to_jsonb(NEW);
  derived text;
  parent_org text;
  i int := 0;
BEGIN
  WHILE i < TG_NARGS LOOP
    IF rec ->> TG_ARGV[i + 1] IS NOT NULL THEN
      EXECUTE format('SELECT "orgId" FROM %I WHERE "id" = $1', TG_ARGV[i])
        INTO parent_org USING rec ->> TG_ARGV[i + 1];
      IF parent_org IS NOT NULL THEN
        IF derived IS NULL THEN
          derived := parent_org;
        ELSIF parent_org <> derived THEN
          RAISE EXCEPTION 'cross-organisation reference: %.% is in another organisation', TG_TABLE_NAME, TG_ARGV[i + 1];
        END IF;
      END IF;
    END IF;
    i := i + 2;
  END LOOP;
  IF derived IS NOT NULL THEN
    NEW."orgId" := derived;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."orgId" IS DISTINCT FROM OLD."orgId" THEN
    RAISE EXCEPTION '%.orgId cannot change (row %)', TG_TABLE_NAME, OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Property now uses the same rule. R-274 re-derived a property's org when it
-- was moved to another org's entity; with orgId on its leases, ledger and
-- evidence that would split one property across two orgs, so the move is now
-- refused the way an entity's is (D-339).
DROP TRIGGER property_derive_org ON "Property";
DROP FUNCTION property_derive_org();
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "legalEntityId" ON "Property" FOR EACH ROW EXECUTE FUNCTION org_scope('LegalEntity', 'legalEntityId');

-- Memberships (D-318). Every existing staff user is staff of org #0.
CREATE TABLE "OrgMembership" (
    "orgId" TEXT NOT NULL,
    "staffUserId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "OrgMembership_pkey" PRIMARY KEY ("orgId","staffUserId")
);
CREATE INDEX "OrgMembership_staffUserId_idx" ON "OrgMembership"("staffUserId");
ALTER TABLE "OrgMembership" ADD CONSTRAINT "OrgMembership_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrgMembership" ADD CONSTRAINT "OrgMembership_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "StaffUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
INSERT INTO "OrgMembership" ("orgId", "staffUserId") SELECT 'org_0', "id" FROM "StaffUser";

ALTER TABLE "Mortgage" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Mortgage_orgId_idx" ON "Mortgage"("orgId");
ALTER TABLE "Mortgage" ADD CONSTRAINT "Mortgage_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MortgageAnnualStatement" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "MortgageAnnualStatement_orgId_idx" ON "MortgageAnnualStatement"("orgId");
ALTER TABLE "MortgageAnnualStatement" ADD CONSTRAINT "MortgageAnnualStatement_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InsurancePolicy" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "InsurancePolicy_orgId_idx" ON "InsurancePolicy"("orgId");
ALTER TABLE "InsurancePolicy" ADD CONSTRAINT "InsurancePolicy_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InsuranceClaim" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "InsuranceClaim_orgId_idx" ON "InsuranceClaim"("orgId");
ALTER TABLE "InsuranceClaim" ADD CONSTRAINT "InsuranceClaim_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InsuranceClaimPayment" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "InsuranceClaimPayment_orgId_idx" ON "InsuranceClaimPayment"("orgId");
ALTER TABLE "InsuranceClaimPayment" ADD CONSTRAINT "InsuranceClaimPayment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InsuranceClaimEvent" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "InsuranceClaimEvent_orgId_idx" ON "InsuranceClaimEvent"("orgId");
ALTER TABLE "InsuranceClaimEvent" ADD CONSTRAINT "InsuranceClaimEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HoaInfo" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "HoaInfo_orgId_idx" ON "HoaInfo"("orgId");
ALTER TABLE "HoaInfo" ADD CONSTRAINT "HoaInfo_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ComplianceItem" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "ComplianceItem_orgId_idx" ON "ComplianceItem"("orgId");
ALTER TABLE "ComplianceItem" ADD CONSTRAINT "ComplianceItem_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ComplianceCompletion" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "ComplianceCompletion_orgId_idx" ON "ComplianceCompletion"("orgId");
ALTER TABLE "ComplianceCompletion" ADD CONSTRAINT "ComplianceCompletion_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CapitalImprovement" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "CapitalImprovement_orgId_idx" ON "CapitalImprovement"("orgId");
ALTER TABLE "CapitalImprovement" ADD CONSTRAINT "CapitalImprovement_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PropertyReserve" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "PropertyReserve_orgId_idx" ON "PropertyReserve"("orgId");
ALTER TABLE "PropertyReserve" ADD CONSTRAINT "PropertyReserve_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Warranty" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Warranty_orgId_idx" ON "Warranty"("orgId");
ALTER TABLE "Warranty" ADD CONSTRAINT "Warranty_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Unit" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Unit_orgId_idx" ON "Unit"("orgId");
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Listing" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Listing_orgId_idx" ON "Listing"("orgId");
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ListingSyndication" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "ListingSyndication_orgId_idx" ON "ListingSyndication"("orgId");
ALTER TABLE "ListingSyndication" ADD CONSTRAINT "ListingSyndication_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ListingLead" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "ListingLead_orgId_idx" ON "ListingLead"("orgId");
ALTER TABLE "ListingLead" ADD CONSTRAINT "ListingLead_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Application" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Application_orgId_idx" ON "Application"("orgId");
ALTER TABLE "Application" ADD CONSTRAINT "Application_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Applicant" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Applicant_orgId_idx" ON "Applicant"("orgId");
ALTER TABLE "Applicant" ADD CONSTRAINT "Applicant_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScreeningCriteria" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "ScreeningCriteria_orgId_idx" ON "ScreeningCriteria"("orgId");
ALTER TABLE "ScreeningCriteria" ADD CONSTRAINT "ScreeningCriteria_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScreeningReport" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "ScreeningReport_orgId_idx" ON "ScreeningReport"("orgId");
ALTER TABLE "ScreeningReport" ADD CONSTRAINT "ScreeningReport_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Prospect" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Prospect_orgId_idx" ON "Prospect"("orgId");
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Showing" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Showing_orgId_idx" ON "Showing"("orgId");
ALTER TABLE "Showing" ADD CONSTRAINT "Showing_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SmartLock" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "SmartLock_orgId_idx" ON "SmartLock"("orgId");
DROP INDEX "SmartLock_provider_externalId_key";
CREATE UNIQUE INDEX "SmartLock_orgId_provider_externalId_key" ON "SmartLock"("orgId", "provider", "externalId");
ALTER TABLE "SmartLock" ADD CONSTRAINT "SmartLock_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdentityCheck" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "IdentityCheck_orgId_idx" ON "IdentityCheck"("orgId");
ALTER TABLE "IdentityCheck" ADD CONSTRAINT "IdentityCheck_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowingAccess" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "ShowingAccess_orgId_idx" ON "ShowingAccess"("orgId");
ALTER TABLE "ShowingAccess" ADD CONSTRAINT "ShowingAccess_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TenantLockCode" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "TenantLockCode_orgId_idx" ON "TenantLockCode"("orgId");
ALTER TABLE "TenantLockCode" ADD CONSTRAINT "TenantLockCode_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LockEvent" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "LockEvent_orgId_idx" ON "LockEvent"("orgId");
ALTER TABLE "LockEvent" ADD CONSTRAINT "LockEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccessCode" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "AccessCode_orgId_idx" ON "AccessCode"("orgId");
ALTER TABLE "AccessCode" ADD CONSTRAINT "AccessCode_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Appliance" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Appliance_orgId_idx" ON "Appliance"("orgId");
ALTER TABLE "Appliance" ADD CONSTRAINT "Appliance_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UtilityAccount" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "UtilityAccount_orgId_idx" ON "UtilityAccount"("orgId");
ALTER TABLE "UtilityAccount" ADD CONSTRAINT "UtilityAccount_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShutoffLocation" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "ShutoffLocation_orgId_idx" ON "ShutoffLocation"("orgId");
ALTER TABLE "ShutoffLocation" ADD CONSTRAINT "ShutoffLocation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Tenant" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Tenant_orgId_idx" ON "Tenant"("orgId");
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Guarantor" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Guarantor_orgId_idx" ON "Guarantor"("orgId");
ALTER TABLE "Guarantor" ADD CONSTRAINT "Guarantor_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Vendor" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Vendor_orgId_idx" ON "Vendor"("orgId");
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VendorInvoice" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "VendorInvoice_orgId_idx" ON "VendorInvoice"("orgId");
ALTER TABLE "VendorInvoice" ADD CONSTRAINT "VendorInvoice_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VendorInvoiceSplit" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "VendorInvoiceSplit_orgId_idx" ON "VendorInvoiceSplit"("orgId");
ALTER TABLE "VendorInvoiceSplit" ADD CONSTRAINT "VendorInvoiceSplit_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EntitySettlement" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "EntitySettlement_orgId_idx" ON "EntitySettlement"("orgId");
ALTER TABLE "EntitySettlement" ADD CONSTRAINT "EntitySettlement_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PropertyExpense" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "PropertyExpense_orgId_idx" ON "PropertyExpense"("orgId");
ALTER TABLE "PropertyExpense" ADD CONSTRAINT "PropertyExpense_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Lease" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Lease_orgId_idx" ON "Lease"("orgId");
ALTER TABLE "Lease" ADD CONSTRAINT "Lease_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LeaseTenant" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "LeaseTenant_orgId_idx" ON "LeaseTenant"("orgId");
ALTER TABLE "LeaseTenant" ADD CONSTRAINT "LeaseTenant_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LeasePartyChange" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "LeasePartyChange_orgId_idx" ON "LeasePartyChange"("orgId");
ALTER TABLE "LeasePartyChange" ADD CONSTRAINT "LeasePartyChange_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LeasePartyChangeParty" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "LeasePartyChangeParty_orgId_idx" ON "LeasePartyChangeParty"("orgId");
ALTER TABLE "LeasePartyChangeParty" ADD CONSTRAINT "LeasePartyChangeParty_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConfidentialCase" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "ConfidentialCase_orgId_idx" ON "ConfidentialCase"("orgId");
ALTER TABLE "ConfidentialCase" ADD CONSTRAINT "ConfidentialCase_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LeaseHold" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "LeaseHold_orgId_idx" ON "LeaseHold"("orgId");
ALTER TABLE "LeaseHold" ADD CONSTRAINT "LeaseHold_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentPlan" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "PaymentPlan_orgId_idx" ON "PaymentPlan"("orgId");
ALTER TABLE "PaymentPlan" ADD CONSTRAINT "PaymentPlan_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentPlanInstalment" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "PaymentPlanInstalment_orgId_idx" ON "PaymentPlanInstalment"("orgId");
ALTER TABLE "PaymentPlanInstalment" ADD CONSTRAINT "PaymentPlanInstalment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScraLookup" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "ScraLookup_orgId_idx" ON "ScraLookup"("orgId");
ALTER TABLE "ScraLookup" ADD CONSTRAINT "ScraLookup_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccommodationRequest" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "AccommodationRequest_orgId_idx" ON "AccommodationRequest"("orgId");
ALTER TABLE "AccommodationRequest" ADD CONSTRAINT "AccommodationRequest_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ViolationCase" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "ViolationCase_orgId_idx" ON "ViolationCase"("orgId");
ALTER TABLE "ViolationCase" ADD CONSTRAINT "ViolationCase_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ViolationObservation" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "ViolationObservation_orgId_idx" ON "ViolationObservation"("orgId");
ALTER TABLE "ViolationObservation" ADD CONSTRAINT "ViolationObservation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AbandonmentCase" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "AbandonmentCase_orgId_idx" ON "AbandonmentCase"("orgId");
ALTER TABLE "AbandonmentCase" ADD CONSTRAINT "AbandonmentCase_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AbandonmentContactAttempt" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "AbandonmentContactAttempt_orgId_idx" ON "AbandonmentContactAttempt"("orgId");
ALTER TABLE "AbandonmentContactAttempt" ADD CONSTRAINT "AbandonmentContactAttempt_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RenterInsurancePolicy" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "RenterInsurancePolicy_orgId_idx" ON "RenterInsurancePolicy"("orgId");
ALTER TABLE "RenterInsurancePolicy" ADD CONSTRAINT "RenterInsurancePolicy_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LeaseEnvelope" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "LeaseEnvelope_orgId_idx" ON "LeaseEnvelope"("orgId");
DROP INDEX "LeaseEnvelope_providerId_key";
CREATE UNIQUE INDEX "LeaseEnvelope_orgId_providerId_key" ON "LeaseEnvelope"("orgId", "providerId");
ALTER TABLE "LeaseEnvelope" ADD CONSTRAINT "LeaseEnvelope_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LeaseSigner" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "LeaseSigner_orgId_idx" ON "LeaseSigner"("orgId");
ALTER TABLE "LeaseSigner" ADD CONSTRAINT "LeaseSigner_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OutboxEvent" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "OutboxEvent_orgId_idx" ON "OutboxEvent"("orgId");
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EventConsumption" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "EventConsumption_orgId_idx" ON "EventConsumption"("orgId");
ALTER TABLE "EventConsumption" ADD CONSTRAINT "EventConsumption_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JobRun" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "JobRun_orgId_idx" ON "JobRun"("orgId");
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StaffAssignment" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "StaffAssignment_orgId_idx" ON "StaffAssignment"("orgId");
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TenantCredential" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "TenantCredential_orgId_idx" ON "TenantCredential"("orgId");
ALTER TABLE "TenantCredential" ADD CONSTRAINT "TenantCredential_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LeasePayer" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "LeasePayer_orgId_idx" ON "LeasePayer"("orgId");
ALTER TABLE "LeasePayer" ADD CONSTRAINT "LeasePayer_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Charge" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Charge_orgId_idx" ON "Charge"("orgId");
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayerAllocation" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "PayerAllocation_orgId_idx" ON "PayerAllocation"("orgId");
ALTER TABLE "PayerAllocation" ADD CONSTRAINT "PayerAllocation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecurringCharge" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "RecurringCharge_orgId_idx" ON "RecurringCharge"("orgId");
ALTER TABLE "RecurringCharge" ADD CONSTRAINT "RecurringCharge_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UtilityBill" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "UtilityBill_orgId_idx" ON "UtilityBill"("orgId");
ALTER TABLE "UtilityBill" ADD CONSTRAINT "UtilityBill_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Payment_orgId_idx" ON "Payment"("orgId");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentInvoiceSplit" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "PaymentInvoiceSplit_orgId_idx" ON "PaymentInvoiceSplit"("orgId");
ALTER TABLE "PaymentInvoiceSplit" ADD CONSTRAINT "PaymentInvoiceSplit_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProcessedStripeEvent" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "ProcessedStripeEvent_orgId_idx" ON "ProcessedStripeEvent"("orgId");
ALTER TABLE "ProcessedStripeEvent" ADD CONSTRAINT "ProcessedStripeEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "LedgerEntry_orgId_idx" ON "LedgerEntry"("orgId");
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Deposit" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Deposit_orgId_idx" ON "Deposit"("orgId");
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DepositDeduction" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "DepositDeduction_orgId_idx" ON "DepositDeduction"("orgId");
ALTER TABLE "DepositDeduction" ADD CONSTRAINT "DepositDeduction_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Ticket_orgId_idx" ON "Ticket"("orgId");
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkOrder" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "WorkOrder_orgId_idx" ON "WorkOrder"("orgId");
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PreventiveMaintenanceTemplate" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "PreventiveMaintenanceTemplate_orgId_idx" ON "PreventiveMaintenanceTemplate"("orgId");
ALTER TABLE "PreventiveMaintenanceTemplate" ADD CONSTRAINT "PreventiveMaintenanceTemplate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkOrderMessageLink" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "WorkOrderMessageLink_orgId_idx" ON "WorkOrderMessageLink"("orgId");
ALTER TABLE "WorkOrderMessageLink" ADD CONSTRAINT "WorkOrderMessageLink_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkOrderNote" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "WorkOrderNote_orgId_idx" ON "WorkOrderNote"("orgId");
ALTER TABLE "WorkOrderNote" ADD CONSTRAINT "WorkOrderNote_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkOrderVerification" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "WorkOrderVerification_orgId_idx" ON "WorkOrderVerification"("orgId");
ALTER TABLE "WorkOrderVerification" ADD CONSTRAINT "WorkOrderVerification_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkOrderBid" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "WorkOrderBid_orgId_idx" ON "WorkOrderBid"("orgId");
ALTER TABLE "WorkOrderBid" ADD CONSTRAINT "WorkOrderBid_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TurnoverProject" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "TurnoverProject_orgId_idx" ON "TurnoverProject"("orgId");
ALTER TABLE "TurnoverProject" ADD CONSTRAINT "TurnoverProject_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Thread" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Thread_orgId_idx" ON "Thread"("orgId");
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UnroutedMessage" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "UnroutedMessage_orgId_idx" ON "UnroutedMessage"("orgId");
ALTER TABLE "UnroutedMessage" ADD CONSTRAINT "UnroutedMessage_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Message" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Message_orgId_idx" ON "Message"("orgId");
ALTER TABLE "Message" ADD CONSTRAINT "Message_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MessageDelivery" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "MessageDelivery_orgId_idx" ON "MessageDelivery"("orgId");
ALTER TABLE "MessageDelivery" ADD CONSTRAINT "MessageDelivery_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Notification_orgId_idx" ON "Notification"("orgId");
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NotificationDelivery" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "NotificationDelivery_orgId_idx" ON "NotificationDelivery"("orgId");
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NotificationPreference" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "NotificationPreference_orgId_idx" ON "NotificationPreference"("orgId");
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MessageTemplate" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "MessageTemplate_orgId_idx" ON "MessageTemplate"("orgId");
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MessageTemplateVersion" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "MessageTemplateVersion_orgId_idx" ON "MessageTemplateVersion"("orgId");
ALTER TABLE "MessageTemplateVersion" ADD CONSTRAINT "MessageTemplateVersion_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MessageTemplateTranslation" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "MessageTemplateTranslation_orgId_idx" ON "MessageTemplateTranslation"("orgId");
ALTER TABLE "MessageTemplateTranslation" ADD CONSTRAINT "MessageTemplateTranslation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AnnouncementSchedule" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "AnnouncementSchedule_orgId_idx" ON "AnnouncementSchedule"("orgId");
ALTER TABLE "AnnouncementSchedule" ADD CONSTRAINT "AnnouncementSchedule_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Audience" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Audience_orgId_idx" ON "Audience"("orgId");
ALTER TABLE "Audience" ADD CONSTRAINT "Audience_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EvictionCase" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "EvictionCase_orgId_idx" ON "EvictionCase"("orgId");
ALTER TABLE "EvictionCase" ADD CONSTRAINT "EvictionCase_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EvictionCost" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "EvictionCost_orgId_idx" ON "EvictionCost"("orgId");
ALTER TABLE "EvictionCost" ADD CONSTRAINT "EvictionCost_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Notice" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Notice_orgId_idx" ON "Notice"("orgId");
ALTER TABLE "Notice" ADD CONSTRAINT "Notice_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RentChange" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "RentChange_orgId_idx" ON "RentChange"("orgId");
ALTER TABLE "RentChange" ADD CONSTRAINT "RentChange_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NoticeDelivery" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "NoticeDelivery_orgId_idx" ON "NoticeDelivery"("orgId");
ALTER TABLE "NoticeDelivery" ADD CONSTRAINT "NoticeDelivery_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InspectionTemplate" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "InspectionTemplate_orgId_idx" ON "InspectionTemplate"("orgId");
DROP INDEX "InspectionTemplate_defaultForType_key";
CREATE UNIQUE INDEX "InspectionTemplate_orgId_defaultForType_key" ON "InspectionTemplate"("orgId", "defaultForType");
ALTER TABLE "InspectionTemplate" ADD CONSTRAINT "InspectionTemplate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Inspection" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Inspection_orgId_idx" ON "Inspection"("orgId");
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InspectionItem" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "InspectionItem_orgId_idx" ON "InspectionItem"("orgId");
ALTER TABLE "InspectionItem" ADD CONSTRAINT "InspectionItem_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentTemplate" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "DocumentTemplate_orgId_idx" ON "DocumentTemplate"("orgId");
ALTER TABLE "DocumentTemplate" ADD CONSTRAINT "DocumentTemplate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Document" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Document_orgId_idx" ON "Document"("orgId");
ALTER TABLE "Document" ADD CONSTRAINT "Document_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "Task_orgId_idx" ON "Task"("orgId");
ALTER TABLE "Task" ADD CONSTRAINT "Task_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "AuditLog_orgId_idx" ON "AuditLog"("orgId");
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TenantConsent" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "TenantConsent_orgId_idx" ON "TenantConsent"("orgId");
ALTER TABLE "TenantConsent" ADD CONSTRAINT "TenantConsent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SmsOptOut" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "SmsOptOut_orgId_idx" ON "SmsOptOut"("orgId");
ALTER TABLE "SmsOptOut" ADD CONSTRAINT "SmsOptOut_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReceivableWriteOff" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "ReceivableWriteOff_orgId_idx" ON "ReceivableWriteOff"("orgId");
ALTER TABLE "ReceivableWriteOff" ADD CONSTRAINT "ReceivableWriteOff_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MessagingSettings" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE UNIQUE INDEX "MessagingSettings_orgId_key" ON "MessagingSettings"("orgId");
ALTER TABLE "MessagingSettings" ADD CONSTRAINT "MessagingSettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApplicantInfoRequest" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "ApplicantInfoRequest_orgId_idx" ON "ApplicantInfoRequest"("orgId");
ALTER TABLE "ApplicantInfoRequest" ADD CONSTRAINT "ApplicantInfoRequest_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApplicantNote" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
CREATE INDEX "ApplicantNote_orgId_idx" ON "ApplicantNote"("orgId");
ALTER TABLE "ApplicantNote" ADD CONSTRAINT "ApplicantNote_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId" ON "Mortgage" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "mortgageId", "documentId" ON "MortgageAnnualStatement" FOR EACH ROW EXECUTE FUNCTION org_scope('Mortgage', 'mortgageId', 'Document', 'documentId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId" ON "InsurancePolicy" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "policyId", "lossOfRentsUnitId", "lossOfRentsLeaseId" ON "InsuranceClaim" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'InsurancePolicy', 'policyId', 'Unit', 'lossOfRentsUnitId', 'Lease', 'lossOfRentsLeaseId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "claimId" ON "InsuranceClaimPayment" FOR EACH ROW EXECUTE FUNCTION org_scope('InsuranceClaim', 'claimId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "claimId", "documentId" ON "InsuranceClaimEvent" FOR EACH ROW EXECUTE FUNCTION org_scope('InsuranceClaim', 'claimId', 'Document', 'documentId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId" ON "HoaInfo" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "legalEntityId" ON "ComplianceItem" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'LegalEntity', 'legalEntityId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "complianceItemId", "documentId" ON "ComplianceCompletion" FOR EACH ROW EXECUTE FUNCTION org_scope('ComplianceItem', 'complianceItemId', 'Document', 'documentId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "workOrderId" ON "CapitalImprovement" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'WorkOrder', 'workOrderId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId" ON "PropertyReserve" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId" ON "Warranty" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId" ON "Unit" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "unitId" ON "Listing" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Unit', 'unitId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "listingId" ON "ListingSyndication" FOR EACH ROW EXECUTE FUNCTION org_scope('Listing', 'listingId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "listingId" ON "ListingLead" FOR EACH ROW EXECUTE FUNCTION org_scope('Listing', 'listingId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "listingId", "prospectId" ON "Application" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Listing', 'listingId', 'Prospect', 'prospectId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "applicationId" ON "Applicant" FOR EACH ROW EXECUTE FUNCTION org_scope('Application', 'applicationId');
CREATE TRIGGER org_scope BEFORE UPDATE OF "orgId" ON "ScreeningCriteria" FOR EACH ROW EXECUTE FUNCTION org_scope();
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "applicantId", "adverseActionNoticeId" ON "ScreeningReport" FOR EACH ROW EXECUTE FUNCTION org_scope('Applicant', 'applicantId', 'Notice', 'adverseActionNoticeId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "listingId" ON "Prospect" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Listing', 'listingId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "unitId", "prospectId", "entryNoticeId" ON "Showing" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Unit', 'unitId', 'Prospect', 'prospectId', 'Notice', 'entryNoticeId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "unitId" ON "SmartLock" FOR EACH ROW EXECUTE FUNCTION org_scope('Unit', 'unitId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "prospectId" ON "IdentityCheck" FOR EACH ROW EXECUTE FUNCTION org_scope('Prospect', 'prospectId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "showingId", "smartLockId", "identityCheckId" ON "ShowingAccess" FOR EACH ROW EXECUTE FUNCTION org_scope('Showing', 'showingId', 'SmartLock', 'smartLockId', 'IdentityCheck', 'identityCheckId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "smartLockId", "leaseId", "tenantId" ON "TenantLockCode" FOR EACH ROW EXECUTE FUNCTION org_scope('SmartLock', 'smartLockId', 'Lease', 'leaseId', 'Tenant', 'tenantId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "smartLockId", "showingAccessId", "tenantLockCodeId" ON "LockEvent" FOR EACH ROW EXECUTE FUNCTION org_scope('SmartLock', 'smartLockId', 'ShowingAccess', 'showingAccessId', 'TenantLockCode', 'tenantLockCodeId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "unitId" ON "AccessCode" FOR EACH ROW EXECUTE FUNCTION org_scope('Unit', 'unitId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "unitId" ON "Appliance" FOR EACH ROW EXECUTE FUNCTION org_scope('Unit', 'unitId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "unitId" ON "UtilityAccount" FOR EACH ROW EXECUTE FUNCTION org_scope('Unit', 'unitId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "unitId" ON "ShutoffLocation" FOR EACH ROW EXECUTE FUNCTION org_scope('Unit', 'unitId');
CREATE TRIGGER org_scope BEFORE UPDATE OF "orgId" ON "Tenant" FOR EACH ROW EXECUTE FUNCTION org_scope();
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "leaseId" ON "Guarantor" FOR EACH ROW EXECUTE FUNCTION org_scope('Lease', 'leaseId');
CREATE TRIGGER org_scope BEFORE UPDATE OF "orgId" ON "Vendor" FOR EACH ROW EXECUTE FUNCTION org_scope();
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "legalEntityId", "vendorId" ON "VendorInvoice" FOR EACH ROW EXECUTE FUNCTION org_scope('LegalEntity', 'legalEntityId', 'Vendor', 'vendorId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "vendorInvoiceId", "workOrderId" ON "VendorInvoiceSplit" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'VendorInvoice', 'vendorInvoiceId', 'WorkOrder', 'workOrderId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "legalEntityId", "documentId" ON "EntitySettlement" FOR EACH ROW EXECUTE FUNCTION org_scope('LegalEntity', 'legalEntityId', 'Document', 'documentId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "legalEntityId", "documentId" ON "PropertyExpense" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'LegalEntity', 'legalEntityId', 'Document', 'documentId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "unitId", "renewedFromLeaseId", "applicationId" ON "Lease" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Unit', 'unitId', 'Lease', 'renewedFromLeaseId', 'Application', 'applicationId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "leaseId", "tenantId" ON "LeaseTenant" FOR EACH ROW EXECUTE FUNCTION org_scope('Lease', 'leaseId', 'Tenant', 'tenantId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "leaseId", "envelopeId" ON "LeasePartyChange" FOR EACH ROW EXECUTE FUNCTION org_scope('Lease', 'leaseId', 'LeaseEnvelope', 'envelopeId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "changeId", "tenantId", "guarantorId", "applicantId" ON "LeasePartyChangeParty" FOR EACH ROW EXECUTE FUNCTION org_scope('LeasePartyChange', 'changeId', 'Tenant', 'tenantId', 'Guarantor', 'guarantorId', 'Applicant', 'applicantId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "leaseId", "restrictedPartyTenantId", "lockChangeWorkOrderId", "partyChangeId" ON "ConfidentialCase" FOR EACH ROW EXECUTE FUNCTION org_scope('Lease', 'leaseId', 'Tenant', 'restrictedPartyTenantId', 'WorkOrder', 'lockChangeWorkOrderId', 'LeasePartyChange', 'partyChangeId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "leaseId", "paymentPlanId", "noticeId" ON "LeaseHold" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Lease', 'leaseId', 'PaymentPlan', 'paymentPlanId', 'Notice', 'noticeId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "leaseId", "envelopeId" ON "PaymentPlan" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Lease', 'leaseId', 'LeaseEnvelope', 'envelopeId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "planId" ON "PaymentPlanInstalment" FOR EACH ROW EXECUTE FUNCTION org_scope('PaymentPlan', 'planId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "leaseId", "tenantId", "evictionCaseId", "certificateDocumentId" ON "ScraLookup" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Lease', 'leaseId', 'Tenant', 'tenantId', 'EvictionCase', 'evictionCaseId', 'Document', 'certificateDocumentId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "leaseId", "tenantId", "violationCaseId" ON "AccommodationRequest" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Lease', 'leaseId', 'Tenant', 'tenantId', 'ViolationCase', 'violationCaseId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "unitId", "leaseId", "legitimizedApplicantId" ON "ViolationCase" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Unit', 'unitId', 'Lease', 'leaseId', 'Applicant', 'legitimizedApplicantId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "caseId" ON "ViolationObservation" FOR EACH ROW EXECUTE FUNCTION org_scope('ViolationCase', 'caseId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "unitId", "leaseId", "entryNoticeId" ON "AbandonmentCase" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Unit', 'unitId', 'Lease', 'leaseId', 'Notice', 'entryNoticeId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "caseId" ON "AbandonmentContactAttempt" FOR EACH ROW EXECUTE FUNCTION org_scope('AbandonmentCase', 'caseId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "leaseId", "documentId" ON "RenterInsurancePolicy" FOR EACH ROW EXECUTE FUNCTION org_scope('Lease', 'leaseId', 'Document', 'documentId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "leaseId", "templateId", "draftDocumentId", "executedDocumentId" ON "LeaseEnvelope" FOR EACH ROW EXECUTE FUNCTION org_scope('Lease', 'leaseId', 'DocumentTemplate', 'templateId', 'Document', 'draftDocumentId', 'Document', 'executedDocumentId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "envelopeId", "tenantId", "guarantorId" ON "LeaseSigner" FOR EACH ROW EXECUTE FUNCTION org_scope('LeaseEnvelope', 'envelopeId', 'Tenant', 'tenantId', 'Guarantor', 'guarantorId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId" ON "OutboxEvent" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "eventId" ON "EventConsumption" FOR EACH ROW EXECUTE FUNCTION org_scope('OutboxEvent', 'eventId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId" ON "JobRun" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "legalEntityId" ON "StaffAssignment" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'LegalEntity', 'legalEntityId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "tenantId" ON "TenantCredential" FOR EACH ROW EXECUTE FUNCTION org_scope('Tenant', 'tenantId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "leaseId", "tenantId" ON "LeasePayer" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Lease', 'leaseId', 'Tenant', 'tenantId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "leaseId", "recurringChargeId", "utilityBillId", "workOrderId", "assessedOnChargeId", "assessedOnPaymentId", "assessedOnLeaseId", "depositId" ON "Charge" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Lease', 'leaseId', 'RecurringCharge', 'recurringChargeId', 'UtilityBill', 'utilityBillId', 'WorkOrder', 'workOrderId', 'Charge', 'assessedOnChargeId', 'Payment', 'assessedOnPaymentId', 'Lease', 'assessedOnLeaseId', 'Deposit', 'depositId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "chargeId", "leasePayerId" ON "PayerAllocation" FOR EACH ROW EXECUTE FUNCTION org_scope('Charge', 'chargeId', 'LeasePayer', 'leasePayerId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "leaseId" ON "RecurringCharge" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Lease', 'leaseId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "documentId" ON "UtilityBill" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Document', 'documentId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "leaseId", "leasePayerId", "receiptDocumentId", "depositSlipDocumentId" ON "Payment" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Lease', 'leaseId', 'LeasePayer', 'leasePayerId', 'Document', 'receiptDocumentId', 'Document', 'depositSlipDocumentId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "paymentId" ON "PaymentInvoiceSplit" FOR EACH ROW EXECUTE FUNCTION org_scope('Payment', 'paymentId');
CREATE TRIGGER org_scope BEFORE UPDATE OF "orgId" ON "ProcessedStripeEvent" FOR EACH ROW EXECUTE FUNCTION org_scope();
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "leaseId", "leasePayerId", "chargeId", "paymentId", "reversesId" ON "LedgerEntry" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Lease', 'leaseId', 'LeasePayer', 'leasePayerId', 'Charge', 'chargeId', 'Payment', 'paymentId', 'LedgerEntry', 'reversesId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "leaseId", "noticeId", "refundDocumentId" ON "Deposit" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Lease', 'leaseId', 'Notice', 'noticeId', 'Document', 'refundDocumentId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "depositId", "workOrderId", "inspectionItemId" ON "DepositDeduction" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Deposit', 'depositId', 'WorkOrder', 'workOrderId', 'InspectionItem', 'inspectionItemId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "unitId", "leaseId", "tenantId", "mergedIntoTicketId" ON "Ticket" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Unit', 'unitId', 'Lease', 'leaseId', 'Tenant', 'tenantId', 'Ticket', 'mergedIntoTicketId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "unitId", "ticketId", "vendorId", "turnoverProjectId", "pmTemplateId", "entryNoticeId", "insuranceClaimId" ON "WorkOrder" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Unit', 'unitId', 'Ticket', 'ticketId', 'Vendor', 'vendorId', 'TurnoverProject', 'turnoverProjectId', 'PreventiveMaintenanceTemplate', 'pmTemplateId', 'Notice', 'entryNoticeId', 'InsuranceClaim', 'insuranceClaimId');
CREATE TRIGGER org_scope BEFORE UPDATE OF "orgId" ON "PreventiveMaintenanceTemplate" FOR EACH ROW EXECUTE FUNCTION org_scope();
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "workOrderId", "messageId" ON "WorkOrderMessageLink" FOR EACH ROW EXECUTE FUNCTION org_scope('WorkOrder', 'workOrderId', 'Message', 'messageId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "workOrderId" ON "WorkOrderNote" FOR EACH ROW EXECUTE FUNCTION org_scope('WorkOrder', 'workOrderId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "workOrderId", "tenantId", "vendorId" ON "WorkOrderVerification" FOR EACH ROW EXECUTE FUNCTION org_scope('WorkOrder', 'workOrderId', 'Tenant', 'tenantId', 'Vendor', 'vendorId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "workOrderId", "vendorId" ON "WorkOrderBid" FOR EACH ROW EXECUTE FUNCTION org_scope('WorkOrder', 'workOrderId', 'Vendor', 'vendorId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "unitId", "leaseId" ON "TurnoverProject" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Unit', 'unitId', 'Lease', 'leaseId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "leaseId", "tenantId", "vendorId", "ticketId", "workOrderId" ON "Thread" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Lease', 'leaseId', 'Tenant', 'tenantId', 'Vendor', 'vendorId', 'Ticket', 'ticketId', 'WorkOrder', 'workOrderId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "routedMessageId" ON "UnroutedMessage" FOR EACH ROW EXECUTE FUNCTION org_scope('Message', 'routedMessageId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "threadId", "tenantId", "vendorId", "ticketId", "workOrderId" ON "Message" FOR EACH ROW EXECUTE FUNCTION org_scope('Thread', 'threadId', 'Tenant', 'tenantId', 'Vendor', 'vendorId', 'Ticket', 'ticketId', 'WorkOrder', 'workOrderId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "messageId" ON "MessageDelivery" FOR EACH ROW EXECUTE FUNCTION org_scope('Message', 'messageId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "eventId" ON "Notification" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'OutboxEvent', 'eventId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "notificationId" ON "NotificationDelivery" FOR EACH ROW EXECUTE FUNCTION org_scope('Notification', 'notificationId');
CREATE TRIGGER org_scope BEFORE UPDATE OF "orgId" ON "NotificationPreference" FOR EACH ROW EXECUTE FUNCTION org_scope();
CREATE TRIGGER org_scope BEFORE UPDATE OF "orgId" ON "MessageTemplate" FOR EACH ROW EXECUTE FUNCTION org_scope();
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "templateId" ON "MessageTemplateVersion" FOR EACH ROW EXECUTE FUNCTION org_scope('MessageTemplate', 'templateId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "templateId" ON "MessageTemplateTranslation" FOR EACH ROW EXECUTE FUNCTION org_scope('MessageTemplate', 'templateId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "templateId" ON "AnnouncementSchedule" FOR EACH ROW EXECUTE FUNCTION org_scope('MessageTemplate', 'templateId');
CREATE TRIGGER org_scope BEFORE UPDATE OF "orgId" ON "Audience" FOR EACH ROW EXECUTE FUNCTION org_scope();
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "unitId", "leaseId" ON "EvictionCase" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Unit', 'unitId', 'Lease', 'leaseId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "evictionCaseId", "documentId" ON "EvictionCost" FOR EACH ROW EXECUTE FUNCTION org_scope('EvictionCase', 'evictionCaseId', 'Document', 'documentId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "leaseId", "applicantId", "documentId", "proofDocumentId", "violationCaseId", "evictionCaseId" ON "Notice" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Lease', 'leaseId', 'Applicant', 'applicantId', 'Document', 'documentId', 'Document', 'proofDocumentId', 'ViolationCase', 'violationCaseId', 'EvictionCase', 'evictionCaseId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "leaseId", "noticeId" ON "RentChange" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Lease', 'leaseId', 'Notice', 'noticeId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "noticeId", "proofDocumentId" ON "NoticeDelivery" FOR EACH ROW EXECUTE FUNCTION org_scope('Notice', 'noticeId', 'Document', 'proofDocumentId');
CREATE TRIGGER org_scope BEFORE UPDATE OF "orgId" ON "InspectionTemplate" FOR EACH ROW EXECUTE FUNCTION org_scope();
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "unitId", "leaseId", "templateId", "entryNoticeId" ON "Inspection" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Unit', 'unitId', 'Lease', 'leaseId', 'InspectionTemplate', 'templateId', 'Notice', 'entryNoticeId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "inspectionId", "moveInItemId" ON "InspectionItem" FOR EACH ROW EXECUTE FUNCTION org_scope('Inspection', 'inspectionId', 'InspectionItem', 'moveInItemId');
CREATE TRIGGER org_scope BEFORE UPDATE OF "orgId" ON "DocumentTemplate" FOR EACH ROW EXECUTE FUNCTION org_scope();
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "legalEntityId", "unitId", "leaseId", "tenantId", "vendorId", "ticketId", "workOrderId", "applicantId", "inspectionItemId", "depositDeductionId", "capitalImprovementId", "accommodationRequestId", "abandonmentCaseId", "violationObservationId", "insuranceClaimId", "messageId" ON "Document" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'LegalEntity', 'legalEntityId', 'Unit', 'unitId', 'Lease', 'leaseId', 'Tenant', 'tenantId', 'Vendor', 'vendorId', 'Ticket', 'ticketId', 'WorkOrder', 'workOrderId', 'Applicant', 'applicantId', 'InspectionItem', 'inspectionItemId', 'DepositDeduction', 'depositDeductionId', 'CapitalImprovement', 'capitalImprovementId', 'AccommodationRequest', 'accommodationRequestId', 'AbandonmentCase', 'abandonmentCaseId', 'ViolationObservation', 'violationObservationId', 'InsuranceClaim', 'insuranceClaimId', 'Message', 'messageId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId" ON "Task" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId" ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "tenantId", "guarantorId", "prospectId" ON "TenantConsent" FOR EACH ROW EXECUTE FUNCTION org_scope('Tenant', 'tenantId', 'Guarantor', 'guarantorId', 'Prospect', 'prospectId');
CREATE TRIGGER org_scope BEFORE UPDATE OF "orgId" ON "SmsOptOut" FOR EACH ROW EXECUTE FUNCTION org_scope();
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "propertyId", "leaseId" ON "ReceivableWriteOff" FOR EACH ROW EXECUTE FUNCTION org_scope('Property', 'propertyId', 'Lease', 'leaseId');
CREATE TRIGGER org_scope BEFORE UPDATE OF "orgId" ON "MessagingSettings" FOR EACH ROW EXECUTE FUNCTION org_scope();
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "applicantId" ON "ApplicantInfoRequest" FOR EACH ROW EXECUTE FUNCTION org_scope('Applicant', 'applicantId');
CREATE TRIGGER org_scope BEFORE INSERT OR UPDATE OF "orgId", "applicantId" ON "ApplicantNote" FOR EACH ROW EXECUTE FUNCTION org_scope('Applicant', 'applicantId');

-- A grant needs a live membership in the grant's org. AFTER, so it sees the
-- orgId org_scope derived. Bridge until R-301 (D-339): in org #0 a missing
-- membership is created rather than refused, because ~78 fixture and seed
-- writers create staff and grants without one. Any other org is enforced now,
-- and a REMOVED membership is never revived, in org #0 included.
CREATE FUNCTION staff_assignment_membership() RETURNS trigger AS $$
DECLARE
  m "OrgMembership"%ROWTYPE;
BEGIN
  SELECT * INTO m FROM "OrgMembership" WHERE "orgId" = NEW."orgId" AND "staffUserId" = NEW."staffUserId";
  IF NOT FOUND AND NEW."orgId" = 'org_0' THEN
    INSERT INTO "OrgMembership" ("orgId", "staffUserId") VALUES (NEW."orgId", NEW."staffUserId");
  ELSIF NOT FOUND OR m."removedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'StaffAssignment needs a live membership: staff % in organisation %', NEW."staffUserId", NEW."orgId";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER staff_assignment_membership
  AFTER INSERT OR UPDATE OF "orgId", "staffUserId" ON "StaffAssignment"
  FOR EACH ROW EXECUTE FUNCTION staff_assignment_membership();

-- One live grant per (person, role, scope) per ORG: the same bookkeeper can be
-- a portfolio-wide owner in two organisations, and those are two grants.
DROP INDEX "StaffAssignment_one_live_grant";
CREATE UNIQUE INDEX "StaffAssignment_one_live_grant"
  ON "StaffAssignment" (
    "orgId",
    "staffUserId",
    "roleId",
    COALESCE("propertyId", ''),
    COALESCE("legalEntityId", '')
  )
  WHERE "revokedAt" IS NULL;
