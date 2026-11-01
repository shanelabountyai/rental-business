-- R-292b: the simulated Twilio's own state (D-27). Org-less on purpose: it
-- stands in for the provider's database, keyed by the subaccount SID.

CREATE TABLE "SimulatedTwilioAccount" (
    "accountSid" TEXT NOT NULL,
    "friendlyName" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "messagingServiceSid" TEXT,
    "brandStatus" TEXT,
    "brandReason" TEXT,
    "campaignStatus" TEXT,
    "campaignReason" TEXT,
    "optInDescription" TEXT,
    "failBrandWith" TEXT,
    "failCampaignWith" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimulatedTwilioAccount_pkey" PRIMARY KEY ("accountSid")
);

CREATE UNIQUE INDEX "SimulatedTwilioAccount_phoneNumber_key" ON "SimulatedTwilioAccount"("phoneNumber");
