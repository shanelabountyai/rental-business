-- R-268 (OQ-20, D-405): an org's greeting and closing for the automated
-- templates that have wording slots. The facts in those messages stay in code.
ALTER TABLE "MessagingSettings" ADD COLUMN "templateWording" JSONB NOT NULL DEFAULT '{}';
