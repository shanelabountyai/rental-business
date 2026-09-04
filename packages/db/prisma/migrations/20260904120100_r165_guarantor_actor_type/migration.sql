-- R-165: a guarantor signing in is now a first-class audit actor, not a
-- SYSTEM entry with the id smuggled into `ref` as a string.
ALTER TYPE "ActorType" ADD VALUE 'GUARANTOR';
