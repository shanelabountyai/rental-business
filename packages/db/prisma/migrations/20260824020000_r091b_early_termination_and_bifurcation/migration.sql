-- R-091b (RISK-04): the statutory early-termination right, and removing a
-- party from a tenancy without their signature.
--
-- NOTHING HERE SAYS WHAT IT PROTECTS EITHER (D-107). Two of the three tables
-- touched below are read by every member of staff who can read a lease at
-- all, so the vocabulary that leaves the permission wall is uniformly
-- neutral: a jurisdiction column says "early termination", a party-change
-- column says "statutory exemption", and the link between a confidential case
-- and the amendment it produced is held on the CASE side, exactly as R-091
-- held the lock-change link. A `confidentialCaseId` on `LeasePartyChange`
-- would be the disclosure, on a row the ordinary lease page renders.
--
-- THE RIGHT IS STATE LAW, SO IT IS CONFIGURATION (D-4) - and this is the
-- half that separates it from R-085's SCRA. §§3931/3955 are federal and
-- uniform, which is why D-82 hardcodes them; a survivor's right to leave
-- early answers to e.g. Tex. Prop. Code §92.016 / §92.0161 and differs by
-- state in whether it exists at all, how much notice it takes, and which
-- classes of documentation the statute accepts.
--
-- THREE-VALUED, BECAUSE "NOBODY HAS TOLD US" IS NOT "NO". The same posture
-- `sourceOfIncomeProtected` and `preMoveOutWalkthroughRequired` already take.
-- Asserting that a state grants no such right, without anybody having looked,
-- is exactly as wrong as asserting that it does - and here the wrong answer
-- refuses somebody a statutory right, so the two failures have to stay
-- distinguishable in the message the operator reads.

ALTER TABLE "JurisdictionRule"
  ADD COLUMN "earlyTerminationRightExists"       BOOLEAN,
  ADD COLUMN "earlyTerminationNoticeDays"        INTEGER,
  -- Which classes of documentation the statute accepts, from the vocabulary
  -- in packages/core/confidential. EMPTY IS NOT "NONE": it means nobody has
  -- itemised them, and the decision then accepts any class that was actually
  -- recorded rather than refusing over this product's own gap.
  ADD COLUMN "earlyTerminationDocumentationTypes" TEXT[];

-- A row cannot say "this state grants no such right" and carry the notice
-- period for it. Days and accepted classes are meaningful only where the
-- right exists; anywhere else they are somebody's half-finished edit
-- masquerading as configuration.
ALTER TABLE "JurisdictionRule"
  ADD CONSTRAINT "JurisdictionRule_early_termination_is_coherent"
  CHECK (
    "earlyTerminationRightExists" IS TRUE
    OR ("earlyTerminationNoticeDays" IS NULL
        AND cardinality("earlyTerminationDocumentationTypes") = 0)
  );

-- Why somebody was removed from a tenancy they never signed off. A dispute
-- asks "you took me off my lease without my consent" in those words, and the
-- answer has to be a column rather than an inference from who is missing from
-- the signer list.
--
-- AN ENUM, NOT FREE TEXT, and that is the disclosure control. This row is
-- rendered on the ordinary lease page and copied into `lease.party_changed`'s
-- audit payload; a free-text basis is an invitation for an operator to type
-- the one sentence this whole feature exists to keep off that screen. One
-- value today: the statute excused the signature. It does not say which
-- statute, because that would name what it protects.
CREATE TYPE "PartyRemovalBasis" AS ENUM ('STATUTORY_EXEMPTION');

ALTER TABLE "LeasePartyChange" ADD COLUMN "unsignedRemovalBasis" "PartyRemovalBasis";

ALTER TABLE "ConfidentialCase"
  -- The amendment this case produced, if it produced one. On this side for
  -- the same reason `lockChangeWorkOrderId` is: the party change has to be
  -- visible to whoever runs the tenancy, and a pointer back would tell them
  -- why it happened.
  ADD COLUMN "partyChangeId"              TEXT,
  -- That the statutory right was claimed and recorded. The DATES live on the
  -- Lease, in R-066's ordinary notice columns, because what the tenancy shows
  -- everybody is a tenant-given notice and nothing more.
  ADD COLUMN "earlyTerminationRecordedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "ConfidentialCase_partyChangeId_key" ON "ConfidentialCase"("partyChangeId");

ALTER TABLE "ConfidentialCase"
  ADD CONSTRAINT "ConfidentialCase_partyChangeId_fkey"
  FOREIGN KEY ("partyChangeId") REFERENCES "LeasePartyChange"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
