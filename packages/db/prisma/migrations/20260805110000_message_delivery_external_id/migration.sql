-- Provider message id for OUTBOUND messages (R-017). See the column's own
-- comment in schema.prisma: Message.externalId covers inbound, where the id
-- arrives with the webhook; outbound writes the immutable row before it
-- transmits, so the id lands on the mutable delivery half instead.

ALTER TABLE "MessageDelivery" ADD COLUMN "externalId" TEXT;

CREATE INDEX "MessageDelivery_externalId_idx" ON "MessageDelivery"("externalId");
