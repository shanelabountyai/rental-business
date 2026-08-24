-- R-097d (COMM-08): keep what an inbound email actually carried.
--
-- R-097a filed the words and threw away the photograph. A tenant standing in
-- front of a leak, photographing it and emailing it, got their sentence
-- recorded and their evidence discarded - silently, which is the part that
-- makes it a defect rather than a gap.
--
-- TWO COLUMNS, AND THE SECOND IS THE HONEST ONE.
--
-- `Document.messageId` hangs a stored attachment off the message it arrived
-- on. One more nullable owner on a table that already carries a dozen, which
-- is this table's established shape - and NOT a column on `Message`, which is
-- append-only: the association is made when the document is written, so
-- there is nothing to amend later and no join table needed (unlike
-- `WorkOrderMessageLink`, which exists precisely because that association IS
-- late).
--
-- `UnroutedMessage.attachmentsDropped` records what could NOT be kept. An
-- unrouted message has no property, and a `Document` has to have one - so an
-- attachment on a message nobody could place is discarded, and inventing a
-- property to hang it on is exactly the guess `decideRoute` refuses to make.
-- What must not happen is that the discarding is invisible: whoever triages
-- the message needs to know there was a photograph, so they can ask for it
-- again. Silently dropping is the defect this migration exists to fix, and
-- fixing it only for the routed case would leave the same defect in the
-- harder half.
ALTER TABLE "Document" ADD COLUMN "messageId" TEXT;
CREATE INDEX "Document_messageId_idx" ON "Document"("messageId");
ALTER TABLE "Document"
  ADD CONSTRAINT "Document_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "UnroutedMessage"
  ADD COLUMN "attachmentsDropped" INTEGER NOT NULL DEFAULT 0;
