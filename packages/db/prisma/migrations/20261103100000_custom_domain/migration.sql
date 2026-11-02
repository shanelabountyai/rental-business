-- R-276 (PRD 10 §4): a custom domain per organisation.

-- The Vercel domain row, beside STRIPE, TWILIO and RESEND.
ALTER TYPE "IntegrationProvider" ADD VALUE 'VERCEL';

-- The host that names this org, written only once Vercel has verified it, so
-- an unverified domain never resolves to anyone. Unique: one host, one org.
-- Lower case and a bare hostname, because `orgIdForHost` compares it with the
-- Host header as is.
ALTER TABLE "Organization" ADD COLUMN "customDomain" TEXT;
CREATE UNIQUE INDEX "Organization_customDomain_key" ON "Organization"("customDomain");
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_customDomain_host"
  CHECK ("customDomain" ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$');

-- The simulated Vercel's own state (D-27). Org-less on purpose: it stands in
-- for the provider's database, keyed by the domain name, as Vercel keys it.
CREATE TABLE "SimulatedVercelDomain" (
    "name" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "verification" JSONB NOT NULL,
    "failWith" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimulatedVercelDomain_pkey" PRIMARY KEY ("name")
);
