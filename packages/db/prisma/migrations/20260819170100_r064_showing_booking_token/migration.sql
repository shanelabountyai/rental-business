-- AlterEnum
-- Kept in its own migration, separate from anything using the new value in
-- the same transaction (Postgres cannot use an enum value added earlier in
-- the same transaction that added it) - matches
-- 20260818160100_r063_lease_sign_token's identical split.
ALTER TYPE "AuthTokenPurpose" ADD VALUE 'SHOWING_BOOKING';
