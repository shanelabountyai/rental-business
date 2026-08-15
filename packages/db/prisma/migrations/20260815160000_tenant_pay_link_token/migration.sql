-- R-046 (PAY-01, COMM-02): pay rent straight from the reminder, no login.
--
-- The rent reminder R-045 sends carries a portal URL sitting behind
-- `requireTenant`, which redirects to an EMAIL-ONLY login with no return-to.
-- That is the same dead end R-032c found for the verification message, and it
-- costs more here: the whole point of a payment reminder is that paying is
-- the next thing that happens, and every step between the tap and the button
-- is somewhere a tenant stops.
--
-- NO PORTAL SESSION (D-45). This purpose grants one standalone page and one
-- action. A leaked token can see that lease's balance and pay that lease's
-- rent; it cannot reach messages, papers, maintenance or lease documents,
-- because there is no session for those routes to trust.
--
-- Multi-use until it expires, like VENDOR_WORK_ORDER and TENANT_VERIFY - a
-- tenant who taps, checks their bank and comes back must not find it dead.
-- Paying twice is prevented by the balance reaching zero, not by burning the
-- token.

ALTER TYPE "AuthTokenPurpose" ADD VALUE 'TENANT_PAY_LINK';
