-- AlterEnum
-- Kept in its own migration, separate from anything using the new value in
-- the same transaction (Postgres cannot use an enum value added earlier in
-- the same transaction that added it) - matches
-- 20260819170100_r064_showing_booking_token's identical split.
ALTER TYPE "AuthTokenPurpose" ADD VALUE 'TICKET_CLARIFY';
