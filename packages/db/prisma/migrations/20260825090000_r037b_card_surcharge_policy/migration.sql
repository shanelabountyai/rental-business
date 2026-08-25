-- R-037b: cardSurchargePermitted becomes a three-state policy.
--
-- Tex. Bus. & Com. Code §604A.003 bars a surcharge on a DEBIT or stored-value
-- card while permitting one on credit. A boolean cannot express that, so the
-- Texas rule row said `true` and this product surcharged debit cards.
--
-- WHY `true` BACKFILLS TO CREDIT_ONLY AND NOT TO ALL, which would be the
-- behaviour-preserving choice. `true` meant "surcharging is permitted here,
-- debit-vs-credit not distinguished" - the seed's own notes said as much. It
-- was never a reviewed statement that debit surcharging is lawful, so
-- preserving it as ALL would carry an unreviewed assumption forward under a
-- name that now asserts something specific. CREDIT_ONLY is the value that is
-- safe under both readings: in a state that permits all cards we forgo
-- revenue, and in a state that bars debit we obey it. Under-collecting is a
-- cost; over-collecting here is a statutory violation, and only one of those
-- two errors is ours to choose.
CREATE TYPE "CardSurchargePolicy" AS ENUM ('NONE', 'CREDIT_ONLY', 'ALL');

ALTER TABLE "JurisdictionRule"
  ADD COLUMN "cardSurchargePolicy" "CardSurchargePolicy" NOT NULL DEFAULT 'NONE';

UPDATE "JurisdictionRule"
  SET "cardSurchargePolicy" = 'CREDIT_ONLY'
  WHERE "cardSurchargePermitted" = true;

ALTER TABLE "JurisdictionRule" DROP COLUMN "cardSurchargePermitted";
