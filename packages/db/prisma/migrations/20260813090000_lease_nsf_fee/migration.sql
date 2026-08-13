-- R-039a: the returned-payment fee the LEASE provides for (PAY-02; D-4, D-12).
--
-- `nsfFeeFor(rule, leaseFeeCents)` has existed since R-039 and has never been
-- callable with a real value, because there was nowhere to put one. The
-- function's own comment says why the column has to exist rather than the
-- amount coming from statute: "the fee is a contractual term first and a
-- statutory ceiling second, and inventing one the tenant never agreed to is
-- how a fee becomes unenforceable at exactly the moment somebody needs to
-- enforce it."
--
-- NULLABLE, and null means the lease is silent, which means no fee. Not zero
-- and not a default: a lease that says nothing about returned payments has
-- not agreed to a fee, and defaulting one in would charge every tenant on
-- every lease signed before this column existed.
--
-- The statutory ceiling stays where it already is - JurisdictionRule's
-- nsfFeePermitted and nsfFeeMaxCents (D-4) - so a state that forbids the fee
-- or caps it lower overrides the lease without anyone editing a lease.
ALTER TABLE "Lease" ADD COLUMN "nsfFeeCents" INTEGER;

-- A lease cannot provide for a negative fee. Cheap, and it is the kind of
-- thing that arrives through a form typo rather than through code.
ALTER TABLE "Lease" ADD CONSTRAINT "Lease_nsfFeeCents_nonnegative"
  CHECK ("nsfFeeCents" IS NULL OR "nsfFeeCents" >= 0);
