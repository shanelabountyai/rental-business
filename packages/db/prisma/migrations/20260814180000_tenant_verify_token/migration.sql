-- R-032c (MAINT-07): a token that lets a tenant answer "was this fixed?"
-- without a login.
--
-- The verification SMS used to carry a portal URL sitting behind
-- `requireTenant`, which redirects to an EMAIL-ONLY login with no return-to.
-- For a tenant with a phone and no email — R-021's whole persona — the one
-- message whose entire value is the tap could not be answered at all.
--
-- Scoped to one work order, one tenant and one round. It opens no session,
-- reads no document and moves no money.

ALTER TYPE "AuthTokenPurpose" ADD VALUE 'TENANT_VERIFY';
