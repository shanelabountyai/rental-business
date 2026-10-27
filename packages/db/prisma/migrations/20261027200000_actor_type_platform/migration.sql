-- R-294a (D-352): a platform admin is an audit actor. Its own migration
-- because Postgres refuses a new enum value inside the transaction that adds
-- it, and the next migration's CHECK names it.
ALTER TYPE "ActorType" ADD VALUE 'PLATFORM';
