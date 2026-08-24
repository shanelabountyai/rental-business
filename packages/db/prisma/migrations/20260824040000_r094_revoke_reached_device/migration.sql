-- R-094: whether the KILL ACTUALLY REACHED THE DEVICE.
--
-- Found by a test that could not see the warning it was looking for, and it
-- is a real defect rather than a test problem. `revokeShowingAccessFor`
-- already knew that the provider had refused or timed out, and said so in the
-- action's return value - which the panel renders through `useActionState`,
-- inside the very form that the successful revoke then unmounts. So the one
-- message in this feature that asks somebody to go and physically change a
-- lock was destroyed by the re-render that followed it, every time.
--
-- "The code was pulled but the lock never heard" is a DURABLE FACT that
-- somebody has to act on, not a toast. It belongs on the row, next to the
-- kill it describes, so it is still on the screen tomorrow.
--
-- THE CHECK IS ONE-DIRECTIONAL, and the first draft of it was not - which
-- this migration refused to apply to a database that already held revoked
-- rows. "Both null or both set" is wrong for exactly those rows: they were
-- pulled before this column existed, so whether the device heard is not
-- false and not true, it is UNKNOWN, and backfilling either value would be
-- inventing an answer about a physical lock. A one-directional CHECK says the
-- only thing that is actually nonsense - a reached-flag on a row nobody
-- revoked - and lets the panel read a null on a revoked row as "not
-- recorded".
ALTER TABLE "ShowingAccess" ADD COLUMN "revokeReachedDevice" BOOLEAN;

ALTER TABLE "ShowingAccess"
  ADD CONSTRAINT "ShowingAccess_revoke_outcome_is_coherent"
  CHECK ("revokeReachedDevice" IS NULL OR "revokedAt" IS NOT NULL);
