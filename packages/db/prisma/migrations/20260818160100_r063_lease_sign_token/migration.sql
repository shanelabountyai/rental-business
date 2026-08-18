-- R-063: one signer's own review-and-sign link for a lease sent for
-- e-signature. Scoped to a single LeaseSigner.id, multi-use until it
-- expires (D-16), like VENDOR_WORK_ORDER/TENANT_VERIFY/TENANT_PAY_LINK/
-- APPLICATION_LINK - see AuthTokenPurpose's own schema comment for the
-- seven-day reasoning.
--
-- Its own migration, separate from the tables that reference it, because
-- Postgres will not let a new enum value be used in the same transaction
-- that added it - the same reason 20260815160000_tenant_pay_link_token
-- stands alone.

ALTER TYPE "AuthTokenPurpose" ADD VALUE 'LEASE_SIGN';
