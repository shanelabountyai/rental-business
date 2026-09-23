# Legal review checklist: seeded Texas config (Milestone 17 gate)

Release gate, backlog flagged-gaps §6 / D-4. Nothing here is legal advice; it lists what a reviewer must confirm, so the review is a walk-through instead of a hunt.

**Both seeded rows are unreviewed.** `JurisdictionRule` TX statewide v1 and `ScreeningCriteria` v1 have `reviewedBy = null`. Source: [packages/db/prisma/seed.mts](../packages/db/prisma/seed.mts).

## How to record the review (no code needed)

1. Sign in as owner, open `/jurisdiction`. The unreviewed-fields coverage list shows what is outstanding.
2. Correct or confirm each value below by adding **v2** (never edit v1: D-4, changing a rule never rewrites history). Fill `citation` and `reviewedBy`.
3. Open `/screening-criteria` and do the same for its v1.
4. Re-open both screens: no unreviewed fields should remain for TX.

## A. `JurisdictionRule` TX v1

| Field | Seeded | Basis claimed | Reviewer question |
|---|---|---|---|
| `graceDays` | 1 | Prop. Code §92.019(a) "a full day past due" | **Flag.** My reading of §92.019(a)(2) is that rent must be unpaid *two full days* after the due date before a late fee attaches. Confirm 1 vs 2. This one changes real money on every late fee. |
| `lateFeeType` / `lateFeePercentBps` | % of rent, 1000 (10%) | Lease policy | Confirm the default is inside the cap. |
| `lateFeeMaxPercentBps` | 1200 (12%) | §92.019(b) safe harbor, ≤4 units | **Flag.** Confirm 12% (≤4 units) vs 10% (>4 units), and that the platform enforces the right one when a landlord owns a larger structure. Also confirm the fee must be in the written lease. |
| `dayCountBasis` | CALENDAR, no holidays | §92.103, §24.005 count plain days | Confirm no weekend/holiday roll applies to any clock the product runs. |
| `depositMaxBps` | null | No statutory cap | Confirm none. |
| `depositDispositionDays` | 30 | §92.103-.104 | Confirm 30 days from surrender, and the forwarding-address condition. |
| `depositEscrowRequired` / `depositInterestRequired` | false / false | Ch. 92 Subch. C | Confirm neither is required. |
| `preMoveOutWalkthroughRequired` | false | No TX right | Confirm none. |
| `earlyTerminationRightExists` / `NoticeDays` / `DocumentationTypes` | true / 30 / PROTECTIVE_ORDER, PROVIDER_STATEMENT | §92.016, §92.0161 | Confirm notice period and that the documentation list is complete (police report deliberately absent). Also confirm the other early-termination sections (military, §92.017) are handled elsewhere or out of scope. |
| `entryNoticeHours` | 24 | No citation, common practice | Confirm no statute or local rule applies; a lease term governs. |
| `payOrQuitDays` | 3 | §24.005 | **Flag.** The eviction-procedure statutes were amended recently; confirm the 3-day minimum, the "unless lease says otherwise" rule and the current service requirements. |
| `noticeToVacateDays` | 30 | §91.001 | Confirm one full rental period for month-to-month. |
| `rentIncreaseNoticeDays` | 30 | No citation | Confirm no statute; lease term governs. |
| `justCauseRequired` | false | Not a just-cause state | Confirm statewide, and note any local ordinance. |
| `retaliationWindowDays` | 180 | "§92.332(a)" | **Check the citation.** The 6-month presumption and the prohibition sit in §92.331-.332; confirm the section number in `citation`. |
| `habitabilityRepairDays` | 7 | §92.056(d) | Confirm the presumption and that the product does not treat it as a hard deadline. |
| `noticeServiceMethods` | See seed | §24.005(f) | Confirm each method per notice type. Posting on the outside of the door is listed as POSTED_WITH_PHOTO; the seed comment says outside posting needs §24.005(f-1) conditions the product cannot verify. Decide whether to keep it. EMAIL deliberately absent from eviction notices. |
| `paymentAllocationOrder` | RENT, LATE_FEE, NSF_FEE, UTILITY, OTHER | Product default | Confirm no statute or lease-form convention requires another order. |
| `nsfFeePermitted` / `nsfFeeMaxCents` | true / 3000 | Bus. & Com. Code §3.506 | Confirm the cap and that the lease must authorise it. |
| `cardSurchargePolicy` / `cardSurchargeMaxBps` | CREDIT_ONLY / null | Bus. & Com. Code §604A.003 | Confirm; note nothing is charged today because funding type is unknown at quote time. |
| `applicationFeeCapCents` | null | No TX cap | Confirm none. |
| `rubsPermitted` | true | Not cited | Confirm; TX utility-allocation rules (Water Code / PUC) apply to submetering and RUBS, which this row does not cite. |
| `sourceOfIncomeProtected` | false | No statewide protection | Confirm, and list local ordinances (the seed names Austin) that need their own rows before those cities are serviced. |
| `citation` | one string | n/a | Reviewer to add every section actually relied on, including any of the above. |

## B. `ScreeningCriteria` v1

| Field | Seeded | Reviewer question |
|---|---|---|
| `incomeToRentMultiplierX100` | 300 (3x) | Owner policy, not statute. Confirm it is applied uniformly and consider voucher/subsidy handling (disparate-impact exposure). |
| `minCreditScore` | 600 | Owner policy. Confirm it is never an automatic decline (code returns MEETS/FAILS/UNKNOWN only) and adverse-action notice text meets FCRA. |
| `evictionLookbackMonths` | 84 | Confirm the window and FCRA reporting limits. |
| `criminalLookbackMonths` | 84 | Confirm individualized-assessment process per HUD 2016 guidance; a hit is a flag, never an automatic decline. |
| `citation` / `reviewedBy` | null / null | Fill on the reviewed version. |

## C. Not config, but the reviewer should be told

- All tenant- and vendor-facing legal/notice text is **draft only**; templates are not covered by this checklist.
- R-246 asks for counsel on clamping versus refusing an MTM roll that would exceed a cap.
- R-228 (unserved entry notice followed by hand service does not re-judge the window) needs counsel on damages for entries already made.
- Only Texas statewide is seeded. Any other state or city has no rule and `rulesFor()` throws for it by design.

## Sign-off

| Reviewer | Bar no. / role | Date | v2 rule id | v2 criteria id |
|---|---|---|---|---|
| | | | | |
