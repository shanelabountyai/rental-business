-- R-293b: the simulated Resend's own state (D-27). Org-less on purpose: it
-- stands in for the provider's database, keyed by Resend's domain id.

CREATE TABLE "SimulatedResendDomain" (
    "domainId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "records" JSONB NOT NULL,
    "failWith" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimulatedResendDomain_pkey" PRIMARY KEY ("domainId")
);
