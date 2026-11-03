-- R-300a: the offboarding states (D-319). Its own migration: a new enum value
-- cannot be used in the transaction that adds it, and the next one's CHECK does.
ALTER TYPE "OrgStatus" ADD VALUE 'FROZEN';
ALTER TYPE "OrgStatus" ADD VALUE 'OFFBOARDED';
