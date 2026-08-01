# 00 — Master PRD
## Rental Operations Platform — Single-Family Rental Business (10–50 Units)

| | |
|---|---|
| **Document status** | Draft v1.0 |
| **Date** | July 31, 2026 |
| **Prepared by** | Senior Rental Business Owner (domain) + Senior Product Owner (product) |
| **Audience** | Founding team, engineering, legal counsel, bookkeeper/CPA |
| **Companion files** | `06-backlog.md` (build order, R-### items) · `07-decisions.md` (**overrides this document where they conflict**) · `../PROGRESS.md` (what has actually been built) |

> **On the numbering.** This product has a single master PRD rather than the storage platform's six module PRDs — it is one operator's business, not four separate surfaces. Files `01`–`05` are intentionally unused so that `06-backlog.md` and `07-decisions.md` sit at the same numbers as their counterparts in the storage repo. If a module here ever grows its own PRD, it takes the next free number.
>
> **Precedence.** `07-decisions.md` amends this document. Where this PRD conflicts with a decision recorded there, the decision wins. Do not re-open settled decisions mid-build; append a new D-number instead.

---

## 1. Executive Summary

This PRD defines a custom property-management platform ("the Platform") for a growing single-family rental (SFR) business operating 10–50 units — primarily single-family homes, plus duplexes and ADUs — run by an owner-operator with a small team (0–3 staff). Properties are held across multiple legal entities (LLCs + personal name), which drives reporting and permission requirements throughout.

The Platform replaces the current patchwork of spreadsheets, personal text messages, email threads, Dropbox folders, and manual payments with **one source of truth for properties, people, money, and maintenance**. It serves three user groups end to end:

1. **Owner/operator + staff** — portfolio dashboard, leasing, rent collection, maintenance dispatch, compliance calendar, financial and tax reporting.
2. **Renters/tenants** — payments, maintenance requests, documents, communications; with a **full staff-mediated fallback for non-digital tenants** (this is a hard requirement, not a nice-to-have).
3. **Maintenance** — in-house tech (offline-tolerant mobile flow) and external vendors (**zero-login magic-link work orders** — vendors will not install an app or create accounts).

Two design principles govern everything:

- **The evidence trail is the product.** Deposit disputes, evictions, habitability claims, fair-housing complaints, and retaliation claims all turn on "who said what, when, and can you prove it." Every message, notice, photo, payment, and approval is timestamped, immutable, and exportable as a court-ready packet.
- **Jurisdiction rules are configuration, not code.** Grace periods, late-fee caps, deposit deadlines, entry-notice hours, and notice periods vary by state and city and are stored as versioned, effective-dated configuration per property. Nothing statutory is hardcoded.

---

## 2. Vision, Goals, and Non-Goals

### 2.1 Vision

A single operating system for a small SFR business, deliberately opinionated for the 10–50 unit owner-operator: fast to run day-to-day with a team of 1–3, self-service enough that tenants and vendors do most of the data entry themselves, and defensible in any dispute because every record is timestamped and auditable. Portfolio growth should not require proportional headcount.

### 2.2 Measurable Product Goals (12 months post-launch)

| Goal | Typical baseline (manual operation) | Target |
|---|---|---|
| Days-to-fill vacancy (list → lease signed) | 30–45 days | ≤ 21 days median |
| % of rent collected by day 5 of month | ~75–85% | ≥ 92% |
| % of rent volume on autopay | ~0–20% | ≥ 60% |
| Median time-to-resolve maintenance ticket (non-emergency) | 7–14 days, untracked | ≤ 5 days, 100% tracked |
| Median time-to-first-response on tenant request | Hours–days, untracked | ≤ 4 business hours |
| % of tenant/vendor communications captured in-platform | ~10% | ≥ 80% |
| Owner admin hours/week (self-reported) | 10–15 hrs | ≤ 5 hrs |
| Deposit dispositions delivered within statutory deadline | Unknown/risky | 100%, system-enforced |
| Tenant portal activation (account + 1 action, 60 days) | n/a | ≥ 85% of active leases |

*Baselines are typical for this segment and should be replaced with the business's actual measured numbers during discovery.*

### 2.3 Explicit Non-Goals for v1

- **No built-in accounting general ledger.** The Platform maintains the per-lease rent/charges ledger; double-entry books stay in QuickBooks via mapped export/sync.
- **No eviction filing automation.** The Platform builds the case file and paper trail; it never files in any jurisdiction.
- **No in-house screening algorithm or AI applicant scoring — ever.** Screening is via an integrated provider; decisions are always explicit human actions (fair-housing posture).
- **No in-house money movement.** All payment credentials live with a PCI-compliant processor (tokenized); the Platform never stores card or bank numbers.
- **No multifamily feature set** (amenity booking, common-area management, CAM reconciliation).
- **No vendor marketplace.** Vendors are the owner's own rolodex invited into workflows.
- **No dynamic/algorithmic rent pricing.**
- **No native mobile apps in v1** (PWA; see NFRs).
- **No white-label multi-landlord productization in v1** (architecture should not preclude it — see Open Question #15).

---

## 3. Personas

| # | Persona | Profile | Key goals | Design implications |
|---|---|---|---|---|
| P1 | **Dana — Owner/Operator** | Owns ~28 SFRs across 2 metros in 3 LLCs; final say on money | One-screen portfolio view; approve big spends from phone; stop being the router between tenants and plumbers | Exception-first dashboard; 2-tap mobile approvals; entity-level filtering everywhere |
| P2 | **Marisol — PM/Assistant** | Part-time or first hire; showings, comms, triage | Clear authority ceilings; templates; get through the queue without asking Dana 15 questions | Work-queue UI; delegated approval ceilings (e.g., ≤$300); bulk actions |
| P3 | **Jordan — Tenant (young professional)** | 26–35, expects Venmo-grade UX | Set-and-forget autopay; 90-second maintenance request with photos; package-tracking-style status | Mobile-first PWA; magic-link auth (no password ceremony); SMS deep links |
| P4 | **Gene — Tenant (older/less tech-savvy)** | 60s+, long-term tenant, pays by check, may have low vision | Pay the way he always has; talk to a human; never be forced onto an app | **Staff-mediated fallback on every tenant flow**; offline payment recording; large text; WCAG 2.1 AA; print/mail path for all notices. The acid test for accessibility |
| P5 | **Ray — In-house Maintenance Tech** | Handyman on the road all day; 60% of jobs | Today's jobs with address, codes, photos, appliance data; close a job in under a minute | Offline-tolerant PWA (basements/dead zones); big buttons; voice-to-text; required completion photos |
| P6 | **Vlad — External Vendor** | Plumber with 5 landlord clients; will not create an account | Get scope + photos + address; confirm a window; upload invoice; get paid | **Zero-login magic-link work orders** via SMS/email. Make-or-break design decision |
| P7 | **Priya — Investor/Partner (read-only)** | Capital partner on a subset of units | Occupancy/collections/NOI-ish view scoped to her properties; downloadable statements | Property-scoped read-only role; proves out permission model (Phase 3) |

**Cross-persona notes:** WCAG 2.1 AA on tenant and vendor surfaces (housing services are a common ADA web-accessibility litigation target). Spanish-language tenant surface is a Should pending Open Question #7 — legal notice translations must be attorney-approved, not machine-translated; routine maintenance chat may be machine-translated. Tenant and tech/vendor surfaces are mobile-primary; owner surface is mobile for approvals/dashboard and desktop for reporting; PM surface is desktop-primary.

---

## 4. End-to-End Journeys (Narrative Use Cases)

These narratives tie the epics in §5 together. Story IDs referenced inline.

### 4.1 Owner: a Monday morning
Dana opens the dashboard at 6am (RPT-01): rent collected vs. expected, delinquency aged in buckets (0–5, 6–15, 16–30, 30+ days), open work orders by priority and age, vacancies with days-on-market and daily cost of vacancy, leases expiring in 90/120 days, and compliance items due in 30 days — filterable by LLC/entity (PROP-04). She taps the delinquency tile, selects everyone past grace, and fires the templated reminder in one action (PAY-06). A $650 water-heater estimate is waiting; she reviews the tech's photos and approves in two taps (MAINT-04). A warning flags that a non-renewal she drafted is within 6 months of that tenant's habitability complaint — she documents the business reason before proceeding (RISK-06).

### 4.2 Tenant lifecycle: inquiry to move-out
A prospect finds the listing via syndication (LEASE-02), answers standardized pre-screening questions (identical for every inquirer — fair-housing posture), books a self-showing with ID verification and a one-time smart-lockbox code (LEASE-08), applies and pays the screening fee online (LEASE-03), and is screened via the integrated provider against **written, versioned screening criteria applied in order of completed application** (LEASE-04). A decline generates an FCRA adverse action notice before the application can be closed (LEASE-05). The approved applicant e-signs the owner's attorney-drafted lease template with merged addenda (LEASE-06); the system requires cleared certified funds for deposit + first month before releasing door codes (PAY/INSP). Move-in condition report is captured room-by-room with photos and tenant countersignature (INSP-01). At renewal time the system flags the lease at 120/90 days, checks the property's rent-increase notice rules, and executes the renewal or MTM rollover on the ledger automatically (LEASE-09). At move-out, the side-by-side move-in/move-out comparison drives an itemized deposit disposition with evidence links, on the statutory deadline countdown (INSP-02, INSP-03).

### 4.3 Maintenance: 11pm "water everywhere!!!"
A tenant texts the business number at 11pm. The SMS creates a ticket automatically (MAINT-01/COMM-01). Because the category is "active leak," the flow immediately shows the tenant the water shutoff location **with the photo stored in the unit record** (PROP-03), pages the on-call person (NOTIF-05), and skips routine self-help. For routine issues, category-specific troubleshooting scripts (breaker, GFCI reset, disposal reset, thermostat battery) run first with pictures, logging whether the tenant tried them (MAINT-01) — cutting truck rolls and supporting billback when a $95 trip turns out to be a tripped GFCI. The work order flows: triage → threshold approval if over limit → dispatch to vendor via magic link with scope, photos, tenant phone, and per-work-order access codes → tenant/vendor schedule directly with entry-notice compliance checked → completion photos required → tenant one-tap "resolved?" verification → invoice attaches and splits to the right property/category → posts to reporting and QuickBooks export **with no re-keying** (MAINT-02 through MAINT-07). The whole thread — tenant, vendor, staff — hangs off one work order, exportable as a PDF packet for an insurance adjuster (COMM-05/06).

### 4.4 Money: the month in rent
Rent charges post automatically on the 1st per lease (PAY-03). Autopay runs on tenant-chosen dates with pre-debit notice (PAY-02). Gene's mailed check is recorded by staff in 15 seconds (PAY-05); a cash-preferring tenant pays at a retail cash network and it posts electronically (PAY-05). Late fees auto-assess after the property's configured grace period, clamped to state caps, with one-click logged waivers (PAY-04) — and a waiver-pattern report exists because inconsistent fee enforcement is a fair-housing pattern risk. An NSF reversal cleanly re-opens the balance, posts the NSF fee, and does not un-trigger downstream notices (PAY-02). When a tenancy enters legal action, the owner flips per-tenant switches: block online payments / block partials / certified-funds-only — because in many states accepting a partial payment after serving notice can void the eviction (PAY-12). Section 8 tenancies run split ledgers: HAP portion vs. tenant portion, bulk HAP deposits allocated across tenants, mid-stream portion changes prorated correctly, and the system never dunns a tenant for the subsidy side (PAY-13).

---

## 5. Functional Requirements — Epics, User Stories, Acceptance Criteria

Priority key: **[M]** Must-have · **[S]** Should-have · **[C]** Could-have · **[W]** Won't-have for v1 (MoSCoW). Acceptance criteria are Given/When/Then. Story IDs are stable and match `06-backlog.md`.

---

### EPIC 1 — Property & Unit Management (PROP) — Must

Foundation entity model: **Entity (LLC) → Property → Unit(s) → Lease → Tenant(s)**. SFR is usually 1 unit per property, but duplexes/ADUs must be modeled correctly.

**PROP-01 [M]** As an owner, I can create a property with address, type, bed/bath, year built, ownership entity, and acquisition date.
- Given a valid address, when I create a property, then the address is validated/geocoded and a unique property record exists.
- Given a created property, when I view it, then I see sections for units, leases, tickets, documents, and financials (empty states OK).
- Given a duplicate address, when I save, then I am warned before a second record is created.

**PROP-02 [M]** As an owner, I can attach one or more units to a property (main house, ADU, duplex side).
- Given a property, when I add a unit, then the unit has its own status (occupied/vacant/make-ready/down), market rent, and attributes.
- Given a unit whose lease ends without renewal, when the end date passes, then unit status auto-transitions to make-ready and appears on the vacancy board.

**PROP-03 [M]** As a PM, I can store unit-level operational data: lock/smart-lock and lockbox codes (with code history log), appliance makes/models/serials/install dates, HVAC filter sizes, paint colors, utility accounts (provider, account #, name-on-account during tenancy vs. vacancy, landlord-revert agreement y/n), and **shutoff locations (water main, breaker panel, gas) with photos**.
- Given a work order on a unit, when the assigned tech opens it, then unit operational data is visible inline without navigation.
- Given access codes, when an external vendor views a work order, then codes are revealed per-work-order only and each reveal is logged.
- Given an emergency ticket in a leak/gas/electrical category, when the tenant is in the intake flow, then the relevant shutoff photo and location are shown immediately.

**PROP-04 [M]** As an owner, I can associate each property with an owning entity so all reporting and exports split by entity.
- Given multiple entities, when I run any financial report, then I can filter and group by entity.

**PROP-05 [M]** As an owner, I have a **compliance calendar** per property: rental licenses/registrations, CO/periodic city inspections, smoke/CO detector certifications, lead disclosures (pre-1978), insurance renewals, HOA dates, property tax due dates and assessment-appeal windows, Section 8 inspection/recertification dates, and entity-level items (LLC annual reports, registered agent).
- Given an obligation with a due date, when the date is ≤ configured lead time (default 30 days; 45–60 for insurance), then the owner is notified and it appears on the dashboard.
- Given a completed item, when marked done with documents attached, then a permanent completion log answers "when was this last done" in one lookup.

**PROP-06 [M]** As an owner, I can store the property "filing cabinet": deed/title/closing disclosure (cost basis), mortgage terms (with ARM-adjustment/balloon-maturity alerts), insurance declarations (carrier, limits, deductible, loss-of-rents y/n), HOA docs including **rental restrictions/caps**, and warranties (roof, HVAC, water heater, appliances, home-warranty contracts).
- Given a work order created on a tracked asset, when the asset has an active warranty, then the system flags "possible warranty coverage" before dispatch.
- Given an insurance policy, when renewal is 45–60 days out, then the owner is alerted (shopping window).

**PROP-07 [S]** As an owner, I can log capital projects/improvements per property (roof 2024, HVAC 2023) with cost, in-service date, and warranty docs, flagged as CapEx distinct from repairs.
- Given an expense flagged CapEx, when I export year-end reports, then it appears on a fixed-asset/CapEx schedule with in-service dates, separate from repair expenses.

**PROP-08 [S]** As an owner, I can maintain a versioned photo library per unit (acquisition, each turn, each inspection), date-stamped and attached to the unit permanently.

---

### EPIC 2 — Listings & Leasing (LEASE) — Must (screening/e-sign via integration)

**LEASE-01 [M]** As a PM, I can create a listing from a unit (photos from the unit library, rent, deposit, requirements, pet policy, available date) and publish to a hosted listing page.
- Given a vacant/make-ready unit, when I create a listing, then unit attributes and current photos pre-fill and I can edit before publish.
- Given jurisdictions with required listing disclosures (deposit amount, fee limits, voucher/source-of-income acceptance), when I publish, then the property's market-specific disclosure template is included.

**LEASE-02 [M]** As a PM, I can syndicate the listing to major listing networks via feed, with lead-source attribution.
- Given a published listing with syndication enabled, when the feed runs, then the listing appears in outbound feeds within 1 hour and inbound leads carry source attribution.
- Given the unit is leased, when I mark it leased, then feeds update to remove it within 24 hours.
- Given lead history, when I view channel analytics, then I see leads, showings, applications, and signed leases by source.

**LEASE-03 [M]** As a prospect, I can submit an online application (one per adult 18+) with ID upload, income docs, residence history, and application fee payment (fee amount configurable; fee caps and portable-screening-report jurisdictions supported via config).
- Given the application form, when I submit complete with fee paid, then I get confirmation and the PM sees it in a pipeline view with a completion timestamp.
- Given an incomplete application, when I leave, then progress is saved and a resume link is sent.
- Given multiple adults in a household, when one applies, then co-applicants get their own links and the applications group.

**LEASE-04 [M]** As a PM, I can run integrated credit/criminal/eviction screening (applicant-initiated, provider-hosted — the Platform never touches SSNs), with results attached to the application. Income verification supports both document upload and bank-linked verification.
- Given the business's **written screening criteria** (configured once, versioned), when results return, then results display alongside criteria but accept/decline is always an explicit human action.
- Given multiple completed applications, when I disposition them, then the system enforces (or requires a logged reason to deviate from) order-of-completed-application processing.
- Given any decision, when recorded, then decision-maker, timestamp, and criteria version in effect are stored immutably.
- Given criminal-history review, when a record appears, then an individualized-assessment notes field is available and retained (HUD guidance posture).

**LEASE-05 [M]** As a PM, I must issue a compliant FCRA adverse action notice when declining (or approving with conditions) based on a consumer report.
- Given a decline citing screening, when I record it, then the system generates the adverse action notice (CRA details, applicant rights), logs delivery, and blocks closing the application until sent or an override-with-reason is logged.

**LEASE-06 [M]** As a PM, I can generate a lease from **the owner's attorney-drafted template** with merge fields (all adults, guarantors, rent, deposit, term, pet terms, utility responsibility matrix) and property-specific addenda (lead paint pre-1978, mold, bedbug, HOA rules, pool, well/septic), then send for e-signature.
- Given an approved application, when I generate a lease, then all merge fields populate and I preview before send.
- Given all parties sign (including guarantors), when complete, then the executed PDF with audit certificate stores against the lease, the lease activates on start date, and the rent schedule + deposit charge are created automatically.
- Given a property in a different state, when I generate, then that state's template/clauses are used (config, not code).
- Given a guarantor, when the lease executes, then the guarantor is a distinct role: screened, financially liable on the ledger, no portal access to maintenance/comms.

**LEASE-07 [M]** As a PM, I can manage the prospect pipeline (inquiry → pre-screened → showing → applied → screened → approved → signed) with standardized pre-screening questions auto-sent to every inquiry identically.
- Given an inbound lead, when it arrives, then the auto-responder sends the standard pre-screening questions (move date, occupants, pets, income range, prior evictions) — identical for all inquirers.

**LEASE-08 [S]** As a PM, I can offer self-showings for vacant units via smart lockbox with identity verification (photo ID capture), one-time codes, entry logs, and instant code kill; and scheduled/escorted showings with SMS reminders for occupied units.
- Given an occupied-unit showing, when scheduled, then the required tenant entry notice is generated, delivered, and logged per the property's notice rules.
- Given a booked showing, when T-1 day and T-2 hours arrive, then SMS reminders send (no-show reduction).

**LEASE-09 [M]** As a PM, I can run the renewal workflow: flag at 120/90 days, market-rent review note, renewal offer with rent-increase notice rules checked per property (notice period and any rent-cap jurisdiction limits), tenant e-sign, ledger auto-update on effective date. Month-to-month rollovers apply the configured MTM rate automatically.
- Given a lease inside the renewal window, when the window opens, then a renewal task is created and the owner sees current vs. proposed rent.
- Given a rent increase exceeding the property's jurisdiction cap or notice period, when I draft the offer, then the system blocks/warns with the specific rule.
- Given a signed renewal or MTM rollover, when effective, then the ledger updates with no manual edits, and renewal rate is tracked as a metric.

**LEASE-10 [S]** As a PM, I can require and track renter's insurance certificates with expiry and lapse alerts.

**LEASE-11 [S]** As a PM, I can intake a tenant's notice to vacate via portal form (date, forwarding address, lease-notice-period check), timestamped; and issue owner non-renewal notices with delivery logging and just-cause-jurisdiction flags.

**LEASE-12 [S]** As a PM, I can run turnover/make-ready as a mini-project: templated checklist (trash-out → repairs → paint → floors → clean → **re-key, logged**), tasks assignable to vendors in sequence, target rent-ready date, actual costs rolled up per turn, and a days-vacant clock from move-out to new move-in.

**LEASE-13 [W]** AI lead-responder / showing chatbot — not v1.

---

### EPIC 3 — Rent & Payments (PAY) — Must

**PAY-01 [M]** As a tenant, I can pay by ACH (free) or card (processing fee passed through and disclosed) via the portal; cash-preferring tenants can pay at a retail cash network that posts electronically to the ledger.
- Given an active lease with balance, when I open the portal, then I see current balance, due date, and itemized charges before paying.
- Given a payment, when the processor confirms, then the ledger posts with pending → settled states tracked and a receipt goes out by the tenant's preferred channel.
- Given payment method entry, when I add bank/card, then credentials are captured in processor-hosted fields — the Platform never stores account or card numbers.

**PAY-02 [M]** As a tenant, I can enroll in autopay (full balance or fixed amount, chosen day; owner can require full-balance), with pre-debit notice, and modify or cancel anytime.
- Given autopay, when the scheduled day arrives, then payment initiates with T-2-day advance notice and post-payment confirmation.
- Given an ACH return/NSF days later, when the processor reports it, then the payment reverses cleanly on the ledger, the NSF fee posts (if configured), tenant and PM are notified, retry rules apply, and **no downstream action (e.g., late-notice cancellation) that was triggered by the provisional payment remains incorrectly in effect**.

**PAY-03 [M]** As the system, I maintain an append-only per-lease ledger projection of charges (rent, late fees, utilities, chargebacks) and payments/credits, built from Stripe webhooks (D-11) and **tenant-visible in the portal**. Stripe is the system of record; this projection is the readable, exportable, jurisdiction-aware view of it and must reconcile to it.
- Given the monthly schedule, when the configured day arrives, then rent charges post automatically per lease.
- Given any ledger entry, when created, then it is append-only; corrections are reversing entries, never edits or deletes, and it originates from a Stripe event rather than a direct write.
- Given a scheduled reconciliation against Stripe, when the projection and Stripe disagree on any lease balance, then the drift is alarmed rather than silently corrected.
- Given a partial payment, when posted, then allocation follows configured order (oldest-first, or rent-before-fees where state law dictates — per-state config).
- Given a court or dispute need, when I export the ledger, then the output is judge-readable: chronological, plain-language, no cryptic codes (also PAY-09).

**PAY-04 [M]** As an owner, late fees apply automatically per property-state policy (grace days; flat/%/daily; state caps), with logged one-click waivers.
- Given grace period N, when day N+1 arrives unpaid, then the late fee posts and the tenant is notified.
- Given a state cap, when the computed fee exceeds it, then the fee clamps to the cap.
- Given a waiver, when granted, then reason and approver are logged, and a **waiver-pattern report by tenant** exists (fair-housing consistency).

**PAY-05 [M]** As a PM, I can record offline payments (check with check #, money order, cash-at-retail) in under 15 seconds, with printable receipts and deposit batching — non-digital tenants are first-class citizens and never need to log in.

**PAY-06 [M]** As an owner, I see a real-time rent roll: every lease, due, paid, balance, autopay status, days late, deposit held, subsidy portion — exportable (lenders and insurers ask for it).
- Given the rent roll, when I filter "balance > 0 past grace," then I can send a templated reminder to all selected in one action.
- Given delinquency, when displayed, then it is aged in buckets (0–5, 6–15, 16–30, 30+ days) with last-contact date.

**PAY-07 [M]** As the system, security deposits are tracked as liabilities, separate from income in all reporting and exports, with per-state rules (max amounts, separate/escrow/interest requirements) and deposit-alternative (surety) recording.

**PAY-08 [M]** As a PM, I can apply prorations (move-in/move-out; daily-rate method configurable and shown transparently on the ledger) and recurring ledger charges: pet rent, flat utility fees, RUBS-style allocations **with the underlying utility bill attached and math documented** (RUBS regulated/prohibited in some jurisdictions — config-gated).

**PAY-09 [S]** As a PM, I can generate a court/dispute-ready PDF ledger statement for any lease and period.

**PAY-10 [S]** As an owner, I can split a single vendor invoice/payment across multiple properties and categories (the $900 handyman invoice covering three houses), with each split flowing to the right property P&L and export mapping.

**PAY-11 [S]** As an owner, I can track per-property/entity reserve targets and actuals, and view a crude capital plan projecting major component replacements (roof, water heater, HVAC) by age.

**PAY-12 [M]** As an owner, I can set per-tenant payment controls when a tenancy enters legal action: **block online payments, block partial payments, certified-funds-only** — because accepting payment after serving notice can void an eviction in many states.
- Given "block payments" is on, when the tenant attempts a portal payment, then the payment is refused with a neutral message and the attempt is logged to the case file.

**PAY-13 [M — if Section 8 present in portfolio; else S]** As an owner, subsidized tenancies (Section 8/HCV) run split ledgers: HAP portion vs. tenant portion; one bulk HAP ACH deposit allocable across multiple tenant ledgers; mid-stream portion changes prorated on recertification effective dates; housing authority, caseworker, HAP contract, inspection dates, and abatement status tracked per tenancy.
- Given a HAP shortfall, when dunning runs, then the system **never pursues the tenant for the HAP portion**.
- Given a failed HQS/NSPIRE inspection, when logged, then remediation work orders are auto-created at urgent priority with the re-inspection deadline attached (abatement = stopped HAP).

**PAY-14 [S]** As an owner, I can manage the delinquency-to-eviction path as a **case file**: state-specific pay-or-quit notice generation with service-method logging (personal/posting-with-photo/mail rules vary; defective service restarts everything), stage tracking (notice → filing → court date → judgment → writ → lockout), cost tracking (filing, service, attorney, lost rent), cash-for-keys as a documented alternative outcome, and a one-click **attorney packet export**: full ledger, all notices with service proof, all communications, photos, lease + addenda.

**PAY-15 [C]** As a tenant, I can opt into rent-payment credit-bureau reporting via a third party.

**PAY-16 [W]** In-platform owner disbursements/trust-account sweeps between entities — v1 keeps money movement simple; splits happen in QuickBooks.

---

### EPIC 4 — Maintenance & Ticketing (MAINT) — Must (the daily-driver epic)

Work-order lifecycle: `Submitted → Triaged → (Approved if over threshold) → Assigned → Scheduled → In Progress → Work Complete → Verified → Invoiced → Closed` (+ `On Hold — warranty claim pending`, `Waiting on Tenant`, `Canceled`).

**MAINT-01 [M]** As a tenant, I can submit a request from my phone in under 2 minutes: category, structured clarifying prompts (2–3 per category — plumbing/electrical/HVAC/appliance/pest/exterior/locks), photos/video, entry permission, pet warning. **SMS to the business number also creates a ticket and threads into it.**
- Given a category selection, when applicable, then a **troubleshooting script with pictures** runs first (tripped breaker, GFCI reset — noting the controlling GFCI may be in another room, disposal reset button/allen key, thermostat battery, furnace switch, flapper, pilot light), logging tried/declined before dispatch is allowed.
- Given an emergency category (active flooding, sewage backup, gas smell, no heat in freezing temps / no AC in dangerous heat, electrical burning/sparking, break-in/door won't secure, only toilet inoperable, CO alarm), when selected, then safety-first instructions show (gas: call gas company & 911 first), the relevant shutoff photo/location from the unit record displays, and on-call staff are paged immediately regardless of hour.
- Given photo upload on a slow connection, when uploads are in flight, then submission is not blocked; photos attach as they land.
- Given a phone-reported issue, when staff log it, then the ticket is identical in structure to a portal ticket (source: phone-logged).

**MAINT-02 [M]** As a PM, I can triage the queue: suggested priority from category (emergency/urgent/routine) with override, merge duplicates, request more info ("waiting on tenant" state), convert to work order.
- Given a new ticket, when the first-response SLA (config, e.g., 4 business hours) nears breach, then the ticket escalates visually and notifies the owner.
- Given a ticket containing habitability keywords (mold, leak, no heat, sewage, infestation), when created, then it auto-elevates to a tracked-response category with response-time logging (see RISK-05).

**MAINT-03 [M]** As a PM, I can create a work order (from ticket or standalone, e.g., make-ready) with scope, access details, priority, cost estimate; assign to in-house tech or external vendor.
- Given assignment to the in-house tech, when assigned, then it appears in his mobile job list with full context: photos, appliance make/model/serial/age, filter sizes, codes, tenant phone.
- Given dispatch to an external vendor, when sent, then the vendor gets a **zero-login magic link** via SMS/email with scope, photos, address, tenant phone; can Accept / Decline / Propose time; and can upload completion photos and an invoice (even a napkin photo) without an account.
- Given no vendor response in X hours (config), when the timer lapses, then the PM is prompted to re-dispatch to the next vendor on the trade's fallback list.
- Given a tracked asset with warranty (PROP-06), when the WO is created, then warranty status surfaces before dispatch; home-warranty claims get the "warranty claim pending" state so the tenant sees progress, not silence.

**MAINT-04 [M]** As an owner, work orders above my configured cost threshold require explicit approval before dispatch; staff have personal ceilings.
- Given a threshold of $500 and an estimate of $650, when created, then it enters Pending Approval and the owner can Approve/Deny/Ask from phone in ≤2 taps with photos and estimate visible.
- Given actuals exceeding approval by more than tolerance (e.g., 10%), when updated, then re-approval is required before closure.
- Given a PM ceiling of $300, when a WO is under it, then the PM approves without the owner; over it, it routes up automatically.
- Given a bid-threshold policy (over $X: collect 2–3 bids), when triggered, then a bid workflow sends scope + photos to selected vendors and compares responses in one view.

**MAINT-05 [M]** As a tech/vendor, scheduling is coordinated with the tenant (direct coordination or tenant grants logged permission-to-enter), with automatic entry-notice compliance.
- Given a jurisdiction requiring N-hours entry notice, when staff schedule a non-emergency entry sooner, then the system warns and requires an override with reason; the notice itself is generated, delivered, and logged.
- Given a scheduled window, when set, then the tenant is notified with reminders at T-1 day; a tenant no-show is logged (trip-charge/billback evidence).

**MAINT-06 [M]** As the in-house tech, I can work jobs offline: cached details, status changes, photos, voice-to-text notes, time and materials — queued locally and synced on reconnect with no data loss ("server wins on state, merge on notes/photos"), with a visible sync indicator.
- Given "Work Complete," when saved, then at least one completion photo is required (config-enforceable).

**MAINT-07 [M]** As a PM, I verify before closing: tenant one-tap "Was this resolved? Y/N" (+ rating); "No" reopens with a flag; reopen rate per vendor is tracked. On close, labor/materials/invoice amounts attach to the property and flow to reporting and QuickBooks export mapping — **work order → invoice → P&L is one chain, no re-keying**.
- Given a closed WO, when I flag it tenant-caused (vs. normal wear / unknown), then a chargeback posts to the tenant ledger with invoice and photos attached and a notice to the tenant (mid-lease chargeback flow, distinct from move-out deposit deductions).

**MAINT-08 [S]** As a PM, I can run recurring/preventive maintenance from schedules and **seasonal batch templates**: HVAC filters (delivered-to-tenant with photo confirmation or done at inspection), HVAC service spring/fall, gutters, roof checks, winterization (exterior faucet notices, vacant-unit winterization checklist, sprinkler blowouts), smoke/CO test-and-battery at every entry (logged — life-safety liability protection) and ~10-year sensor replacement, water heater flush, dryer vent cleaning, sump pump test, pest/termite, well/septic, chimney — one click creates the batch across properties, assigned by vendor territory.
- Given an annual/semi-annual unit inspection template, when scheduled, then it generates a checklist+photo walkthrough (this is where unreported leaks and unauthorized pets get caught).

**MAINT-09 [S]** As a vendor, I can see invoice status (received → approved → paid-marked); invoices within approved-estimate tolerance route straight to the approved-for-payment list.

**MAINT-10 [S]** As an owner, I see maintenance analytics: spend per property/unit, mean time-to-resolve by priority, repeat-issue detection (same category, same unit, 90 days), reopen rate and average cost per vendor.

**MAINT-11 [S]** As a PM, I manage vendor records: trades, service areas, rates, **W-9 on file (payment blocked/flagged without it)**, license numbers where required, **COI with expiry tracking** (alerts; dispatch to a lapsed-COI vendor warns/holds), preferred lists per trade with fallback order, cumulative calendar-year payment totals by payment method for 1099-NEC flagging.

**MAINT-12 [S]** As an owner, after-hours emergencencies route via an on-call toggle (even a 2-person operation): page on-call → escalate SMS → call → backup; tenant gets immediate mitigation instructions from the unit record; emergency vendor list per trade.

**MAINT-13 [W]** In-platform vendor bill-pay rails — v1 marks paid; money moves outside.

---

### EPIC 5 — Communications Hub (COMM) — Must

Core principle: **every communication is potential evidence.** One threaded, timestamped, immutable history per tenancy, per property, per vendor — regardless of channel.

**COMM-01 [M]** All tenant conversations thread into one inbox across portal, SMS (dedicated business number), and email; staff phone calls are logged as timestamped call notes in the same thread (contemporaneous notes carry legal weight).
- Given a tenant SMS reply, when received, then it lands in the same thread, attributed and timestamped.
- Given any staff member opens a thread, when reading, then full history shows including which staff member sent what.
- Given in-platform texting, when used, then it must be as fast as native texting (speed is the anti-side-channel feature — if it's slower, staff will bypass it under pressure).

**COMM-02 [M]** As a tenant, I choose my preferred channel; legally significant notices additionally deliver per state-valid service methods (config), with **delivery proof**: certified-mail tracking logging (or integrated physical-mail API with proof), portal delivery with read receipt, and "posted on door" with **photo of the posted notice + timestamp**.
- Given Gene (paper-preferring), when a notice sends, then a print-ready PDF generates and staff mailing is logged manually.
- Given TCPA obligations, when a tenant is onboarded, then SMS consent is explicitly captured and stored; STOP is honored automatically.

**COMM-03 [M]** As a PM, I use managed templates with merge fields: rent reminders, late notices, entry notices, violation notices (noise, unauthorized occupant, lawn, trash), renewal offers, seasonal notices, utility-interruption notices, welcome packets — with preview before send.
- Given a tenant language preference, when sending a template, then the stored attorney-approved translation is used for legal notices (machine translation permitted only for routine chat).

**COMM-04 [M]** As a PM, I can send segment announcements (all tenants / one property / one metro / tag) with per-recipient delivery status.

**COMM-05 [M]** Every message, notice, and delivery event writes to an immutable audit log (who, what, when, channel, delivery status); any thread exports as a timestamped PDF transcript with delivery metadata (court/adjuster packet).

**COMM-06 [M]** Ticket- and work-order-related messages thread onto the ticket/WO itself — tenant thread, vendor thread, and staff notes hang off the same object with one exportable timeline.

**COMM-07 [S]** As an owner, I set quiet hours on automated outbound (no 3am late-fee texts; emergencies exempt) and after-hours auto-responses; unanswered emergency tickets escalate SMS → call → backup; unanswered tenant messages past X days surface on the dashboard.

**COMM-08 [C]** Inbound email to a dedicated address auto-threads to the right tenant conversation.

**COMM-09 [W]** In-platform voice calling/recording — v1 logs calls manually.

---

### EPIC 6 — Inspections & Move-in/Move-out (INSP) — Must (the deposit-defense epic)

**INSP-01 [M]** As a PM, I run a move-in inspection from a room-by-room checklist: per-item condition, notes, photos (auto-timestamped, geotagged), producing a tenant-signed condition report — mobile-first (walk, tap room, photo, note, done).
- Given a completed inspection, when finished, then the tenant reviews and e-signs (portal or on the inspector's phone), or it auto-finalizes after a stated response window; the report locks immutably against the lease.
- Given move-in, when keys/codes are issued, then issuance is logged; and door codes are not released until move-in funds show **cleared** (certified funds supported).

**INSP-02 [M]** As a PM, I run the move-out inspection with **side-by-side per-item comparison against move-in** (move-in photo next to move-out photo) — this comparison is the deposit-disposition evidence.
- Given a state granting a pre-move-out walkthrough right, when a move-out is scheduled, then the pre-inspection with itemized fixable list is calendared automatically.

**INSP-03 [M]** As a PM, I produce the deposit disposition: itemized deductions each linked to evidence (inspection photo / work order / invoice) with **age-based depreciation guidance** (full replacement cost on 9-year-old carpet loses in court), minus balance owed, generating the statutory letter on the state deadline countdown.
- Given a recorded move-out date, when saved, then the statutory disposition countdown starts (deadline per state config) with escalating reminders; owner alerted at 50% elapsed; **100% on-deadline delivery is a product goal**.
- Given a deduction without linked evidence, when added, then it is flagged "unsupported" in the record.
- Given disposition finalized, when sent, then delivery to the forwarding address (or last-known per state rules) is logged and the deposit liability zeroes out.

**INSP-04 [S]** As a PM, I schedule periodic inspections (annual interior, seasonal exterior, drive-bys) using the same checklist machinery, generating tasks and photo records over time.

**INSP-05 [S]** As a tenant, I can submit a self-guided move-in condition report within X days (photo walkthrough on my phone), reducing staff trips; auto-finalize window applies.

**INSP-06 [S]** Make-ready integration: move-out inspection findings auto-draft the turnover punch list (LEASE-12) as work orders.

---

### EPIC 7 — Documents & E-sign (DOC) — Must

**DOC-01 [M]** Every document (leases, addenda, notices, invoices, insurance, inspection reports, photos, W-9s, COIs) attaches to the right entity (property/unit/lease/tenant/ticket/vendor) and is findable by entity, type, and date, with versions.

**DOC-02 [M]** As a PM, I can send any document for embedded e-signature with signer order and status tracking; completion certificates store alongside PDFs.

**DOC-03 [M]** As a tenant, I access my documents (lease, notices, receipts) and **only** mine — enforced server-side and verified by permission tests.

**DOC-04 [S]** As a PM, I generate documents from merge-field templates beyond leases (notices, letters, estoppel certificates for property sales).

**DOC-05 [S]** Retention rules per document class (config): leases + ledgers ≥ 7 years post-termination; screening data purged per FCRA/provider terms keeping only decision + adverse-action record; declined-applicant PII minimized on schedule; application records retained per counsel's fair-housing-defense guidance.

**DOC-06 [S]** Bulk export of a property's or lease's full file — the **sale/acquisition handoff packet**: leases, ledgers, deposit amounts (with tenant-notification-of-transfer templates), keys/codes list, vendor history, warranties, estoppel certificates. Everything exportable always (CSV/PDF) — easy export is why owners trust and stay.

---

### EPIC 8 — Reporting & Dashboards (RPT) — Must (thin) / Should (deep)

**RPT-01 [M]** Owner landing dashboard, exception-first: rent collected vs. billed, aged delinquency, open tickets by priority/age (emergency/urgent >48h glow red), vacancies with days-on-market and stage, leases expiring ≤90/120 days, pending approvals, compliance items ≤30 days — every tile drills into the underlying filtered list; filterable by entity.

**RPT-02 [M]** Rent roll + delinquency aging report (the Monday-morning report): who owes what, how long, last contact — any date range, by property/entity, CSV/PDF.

**RPT-03 [M]** Income/expense export mapped to the QuickBooks chart of accounts per entity, with Schedule E-aligned default categories (advertising, cleaning/maintenance, insurance, legal/professional, management fees, mortgage interest, repairs, supplies, taxes, utilities, etc.) and **CapEx flagged separately with in-service dates**.
- Given the export, when run, then every line carries an account mapping or lands on an "unmapped" exception list — nothing silently dropped.

**RPT-04 [M]** The five weekly operating reports as first-class saved views: (1) rent roll + delinquency aging, (2) open work orders by age/priority, (3) vacancy/turn status (stage, days vacant, rent-ready ETA, leads/showings/applications this week), (4) cash summary per entity (collected vs. scheduled, big outflows, reserve vs. target), (5) upcoming critical dates next 60 days (lease expirations, compliance, insurance renewals, COI expiries, deposit-return clocks).

**RPT-05 [S]** Per-property operating snapshot: income, maintenance spend, vacancy days, ticket counts — the "which house is a lemon" view. Monthly/quarterly: P&L per property, renewal rate/turnover cost, vendor spend by trade.

**RPT-06 [S]** Leasing funnel: leads by source, showing→application→approval conversion, days-to-fill per vacancy, cost/quality by channel.

**RPT-07 [S]** Year-end tax packet: Schedule E-style per property, CapEx/fixed-asset schedule, mortgage interest (1098 reconciliation), security deposit liability, **1099-NEC candidate list** (vendors over threshold by payment method, W-9 status), mileage log if captured.

**RPT-08 [C]** Investor/partner scoped read-only dashboard + owner statements (income, expenses, work done, cash position) and contribution/distribution ledger per ownership split (depends ROLE-04).

**RPT-09 [W]** Full financial statements (P&L/balance sheet) — QuickBooks' job.

---

### EPIC 9 — Notifications Engine (NOTIF) — Must (platform capability)

**NOTIF-01 [M]** All modules emit events into one notification engine (recipient, channel per preference, template, delivery) — no module hand-rolls sending; all attempts/failures/retries logged centrally.

**NOTIF-02 [M]** Per-category channel preferences per user; legally-critical categories (legal notices, emergency maintenance) locked on with explanation.

**NOTIF-03 [M]** Time-based rules fire without human action: rent reminder (T-3), due-date reminder, late notice (grace+1), lease expiry (T-120/90/60/30), deposit-disposition countdown, COI/insurance/license expiries, autopay pre-debit, compliance calendar leads. State-specific timing wins where property config differs.

**NOTIF-04 [S]** Daily digest option for non-urgent events (notification fatigue kills adoption).

**NOTIF-05 [S]** Escalation chains: emergency ticket unacknowledged 15 min → escalate past on-call to owner; approval pending >24h → re-ping then escalate; quiet hours respected except emergencies.

---

### EPIC 10 — Users, Roles & Permissions (ROLE) — Must

**ROLE-01 [M]** Role-based access: Owner (all), Manager (configurable ceilings), Maintenance Tech (assigned jobs + unit ops data only), Tenant (own lease/tickets/docs/payments only), Guarantor (financial liability visibility only), Vendor (per-work-order magic-link scope), Read-only/Partner. Authorization enforced server-side per role **and record scope**, not just hidden UI.

**ROLE-02 [M]** Financial ceilings per staff user (approve maintenance ≤ $X, waive fees ≤ $Y, no ledger edits); over-ceiling actions route up automatically. Example boundary: part-time helper sees maintenance and comms but not partner financials; bookkeeper the reverse.

**ROLE-03 [M]** Immutable audit log on every privileged action (ledger adjustment, waiver, approval, permission change, document deletion-marking, screening decision, code reveal): actor, timestamp, before/after. Every record has an edit history — "here is the contemporaneous record" is the defense in every dispute. Log entries cannot be edited or deleted by any role.

**ROLE-04 [S]** Property-scoped users (partner sees only her 6 units; second PM handles only Metro B).

**ROLE-05 [M]** Auth: strong passwords + MFA required for staff before first privileged action; magic-link (short-lived, single-use) for tenants and vendors to minimize friction; confidential flags (e.g., DV-related records, RISK-04) visible only to Owner role.

**ROLE-06 [S]** Deactivate any user (departing staff, past tenant) preserving all history, access killed within 1 minute.

**ROLE-07 [W]** SSO/SAML, custom role builder — enterprise features, not for a 3-person team.

---

### EPIC 11 — Edge Cases & Risk Workflows (RISK) — Should (the scar-tissue epic)

The Platform's job in edge cases: (1) case-file everything with timestamps, (2) surface deadline clocks, (3) never block human/legal judgment. A meticulous paralegal, not a lawyer.

**RISK-01 [S] Tenant goes dark / abandonment.** Escalating contact attempts (logged) → state-compliant welfare/abandonment process with proper entry notice → entry photos → statutory abandonment workflow (notice periods, belongings handling per state config). Done wrong, this converts to an unlawful-eviction claim; the case file is the protection.

**RISK-02 [S] Unauthorized occupants/pets.** Documented cure-or-quit notice flow with photo evidence and deadline tracking; a first-class "legitimize it" path (add occupant via application + screening; convert pet to authorized with screening/fees) because that is the common real-world outcome.

**RISK-03 [S] Hoarding.** Long-timeline case file: inspection photos over time, violation-notice series targeting lease/safety terms (blocked egress, fire load, pests) — never the person — and reasonable-accommodation request tracking (hoarding disorder may trigger fair-housing accommodation obligations).

**RISK-04 [S] Domestic violence / VAWA.** Confidential flags (tightly access-controlled, ROLE-05); early-termination rights processing; lock-change work orders with restricted-party notes; lease bifurcation (remove perpetrator, retain survivor) as a lease-amendment path.

**RISK-05 [M] Habitability complaints (mold, no heat, sewage, infestation).** The moment "mold" appears in writing, the clock starts. Auto-elevation (MAINT-02), response-time logging, before/during/after remediation photos, professional testing/remediation invoices attached. Rent-withholding and repair-and-deduct exposure hinges on the notice + response timeline.

**RISK-06 [M] Retaliation-claim guard.** Many states presume retaliation when the owner raises rent / non-renews / serves notices within a window (commonly ~6 months) after a tenant complaint or exercise of legal rights. When such an action is drafted inside the window, the system warns: *"You are issuing a non-renewal 6 weeks after this tenant's habitability complaint — document your business reason,"* and requires a logged reason. This is a lawsuit-prevention feature no mainstream tool has.

**RISK-07 [S] Insurance claims.** Claim object linking work orders, photos/video (immediate capture prompts — mitigation speed decides water-claim disputes), mitigation invoices, claim number, adjuster contact, correspondence, payout vs. actual repair cost, loss-of-rents evidence from the rent roll; insurance-proceeds accounting on the property P&L.

**RISK-08 [S] Acquisition with inherited tenants.** Onboarding workflow: tenant intake form, estoppel-style confirmation of terms, documented deposit transfer status, new lease or documented MTM at first opportunity, and **baseline "condition as found" photos ASAP** (timestamped — you cannot charge move-out damage against a baseline never captured).

**RISK-09 [S] Mid-lease sale.** Handoff packet per DOC-06 (leases survive sale; deposits transfer with required tenant notification; estoppel certificates).

**RISK-10 [S] Roommate changes / lease assignment.** Departing-tenant release form; hard rule that the **deposit stays with the unit until full turnover** (no partial mid-tenancy refunds); replacement applicant screened to full criteria; amendment e-signed by all; ledger continuity.

**RISK-11 [C] Deceased tenant.** Case workflow: secure unit, document contents, log next-of-kin contacts, release only to the legally entitled party (executor/administrator/small-estate affidavit per state), hold timeline, lease termination per state rules — everything logged.

**RISK-12 [S] SCRA/military.** Military-status flag; orders-based early termination processing; **eviction workflow prompts the SCRA affidavit/DOD lookup check** (courts require it for default judgments).

**RISK-13 [S] ESA/assistance animal requests.** Request intake → documentation review (dated records; reliable documentation may be requested for non-obvious disabilities) → written determination → animal recorded as "assistance animal," distinct from "pet," with **no pet fees/deposits/pet rent and no breed/size limits applied**. The request/response timeline must be airtight — mishandling is a top fair-housing complaint source.

---

## 6. Non-Functional Requirements

### 6.1 Security & Data Protection
- **Payments: zero card/bank data storage.** Processor-hosted fields, tokens only → SAQ-A-level PCI scope. Non-negotiable architecture.
- SSNs never touch the Platform (provider-hosted screening flows); if ever unavoidable, field-level encryption, never displayed after entry.
- TLS 1.2+ in transit, encryption at rest, secrets vaulted, least-privilege server-side authorization per role and record scope.
- SOC 2-ish posture without the audit for v1: access logging, change management, dependency scanning, environment separation, incident-response runbook.
- Staff MFA mandatory; tenant/vendor magic links short-lived and single-use.

### 6.2 Privacy & Retention
- Retention as per-class configuration (see DOC-05). Data-subject deletion supported for prospects/applicants; tenant ledger/legal records exempt with documented lawful basis.

### 6.3 Fair Housing & Screening Compliance (product-enforced)
- Criteria configured once, versioned, uniformly applied; UI never auto-declines; every decision logs decision-maker + timestamp + criteria version.
- Adverse-action generation is workflow-enforced (LEASE-05). No AI/ML applicant scoring anywhere, ever.
- Template linting (Could) for discriminatory-language footguns in listing copy.
- Fee-waiver and enforcement-consistency reports (PAY-04) to surface disparate-treatment patterns early.

### 6.4 Accessibility
- WCAG 2.1 AA on all tenant/vendor surfaces (AA-target on staff surfaces); automated checks in CI + manual screen-reader pass per release on tenant flows; 16px base minimum, 44px touch targets, no color-only status encoding; ≤8th-grade reading level for tenant comms templates; every tenant flow has a staff-mediated fallback (P4 Gene is the acid test).

### 6.5 Tech Stack, Performance, Availability, Mobile

**Stack (D-1 — same as the self-storage platform, deliberately).**

| Layer | Choice | Notes |
|---|---|---|
| App | Next.js (App Router) + TypeScript, React | Monorepo: `apps/web` |
| Domain logic | `packages/core` | Money math, jurisdiction-rule resolution, metrics definitions, proration — all unit-tested, no UI imports |
| Data | Postgres + Prisma (`packages/db`) | Migrations checked in; seed + demo scripts |
| Auth | Auth.js | Staff password + MFA; tenant magic-link; vendor signed single-use links (no accounts, D-6) |
| Payments | **Stripe Billing** — Subscriptions drive recurring rent; Stripe is the system of record for invoices and payments (D-11) | Hosted fields only; no card or bank data stored. Jurisdiction-dependent amounts are computed in `packages/core` and pushed as invoice items (D-12) |
| UI | Tailwind CSS + shadcn/radix | WCAG 2.1 AA enforced in CI |
| Email / SMS | Resend / Twilio | 10DLC registration starts at project setup — external lead time |
| Jobs | Vercel Cron or Inngest-class runner + domain-event outbox | **Every scheduled job runs in property-local time**, never UTC midnight (D-3) |
| Testing | Vitest (unit), Playwright (e2e), axe (a11y), Lighthouse CI | Money math, jurisdiction rules and the maintenance funnel are non-negotiable test targets |
| Hosting | Vercel | |

**Cross-cutting invariants.** Money is integer cents; timestamps are UTC in the database and property-local for display. **Stripe is the system of record for money and `LedgerEntry` is an append-only projection built from its webhooks** (D-11) — reconciled on a schedule, with drift alarmed. Statutory values are never literals — they resolve through `rulesFor(property, asOf)`, are computed in core, and are pushed to Stripe rather than generated by it (D-12). Notifications always route through the notification engine. Photo EXIF timestamps are preserved because they are evidence.

**Performance and availability.**
- p95 page interactive < 3s on mid-tier mobile over LTE; p95 API < 500ms; photo upload viable on 3G-class links (client-side compression, resumable uploads).
- Uptime target 99.5% (internal tool economics); payment and emergency-ticket paths get priority monitoring. Batch jobs (charge posting, notifications) idempotent and re-runnable; the 1st–5th is peak.
- **PWA over native** for v1: no app-store install wall (activation killer), instant updates, magic-link deep linking; SMS as the reliable notification backstop; revisit native only if tech-app offline demands outgrow service workers (Phase 3 decision).
- Offline tolerance for the tech (MAINT-06): IndexedDB queue, "server wins on state, merge on notes/photos," explicit sync indicator.
- **Field usability bar:** log a call or expense in under 15 seconds, one-handed, in a driveway. Photos file themselves to the right unit/WO. Any required field can be deferred ("save incomplete, nag me later") — hard-required fields cause abandoned records, and abandoned records kill data trust.

### 6.6 Auditability & Backups
- Append-only audit log for privileged actions and all communications (ROLE-03, COMM-05).
- Daily backups + point-in-time recovery; quarterly restore drill; RPO ≤ 24h, RTO ≤ 8h; document/photo store versioned with soft-delete + 30-day undelete.

### 6.7 Multi-Jurisdiction Rules Engine — Configuration, Not Code
- A versioned, effective-dated `jurisdiction_rules` layer consumed by payments, notices, deposits, entry scheduling, and screening: grace days; late-fee type/caps; deposit max, disposition deadline days, escrow/interest flags; entry-notice hours; notice day-counts (template generation only); payment allocation order; just-cause restrictions flag; application-fee caps / portable-report flags; RUBS permissibility; required lease clauses per state.
- Adding a jurisdiction = adding a reviewed config record + lease template, not a release. Rule changes apply prospectively, never retroactively. Legal review per config before activation (see Risks).
- Ship sane defaults; make everything a rule; never hardcode a statute.

### 6.8 Data Migration & Onboarding (adoption-critical)
- Import tooling: CSV of tenants/leases/opening balances, bulk document upload, "start clean from a date" mode. Onboarding 30 properties' history decides whether the switch ever happens.
- Every automated action has a visible log and an easy reverse — one wrong auto-fee to a good tenant destroys trust in automation.

---

## 7. Integrations & Build-vs-Buy

Posture: **integrate everything regulated or commoditized; build only the workflow glue and the ledger** (the ledger is bookkeeping logic and the product's spine — not money movement).

| Capability | Decision | Provider class | Rationale / notes |
|---|---|---|---|
| Recurring billing + payments (ACH, card, cash network) | Integrate — **Stripe Billing** (D-11) | Stripe Subscriptions/Invoices; PayNearMe-class retail cash alongside | Money transmission, PCI, NACHA, fraud, retries and dunning mechanics all sit with Stripe. **Underwriting is a schedule risk: apply week 1**; multi-LLC KYB friction is real (4–8 weeks worst case). Two documented limits shape the build: partial payments require the `send_invoice` collection method and are unavailable on automatically-charged subscriptions (OQ-11), and an invoice has exactly one payer, so voucher tenancies need two subscriptions (OQ-12). |
| Tenant screening | Integrate | TransUnion SmartMove-class (applicant-initiated) | FCRA obligations, bureau access; applicant-pay removes billing complexity; landlord never handles SSN. |
| Income verification | Integrate | Plaid-class bank-linked + doc upload | Paystubs are easily faked; bank-linked is materially better. |
| E-signature | Integrate (embedded) | Dropbox Sign / DocuSign-class | ESIGN/UETA validity, audit certificates; choose on embedded-envelope pricing at ~100–200/yr. |
| Listing syndication | Integrate | Zillow/Zumper-class feeds (may require an approved aggregator partner) | Distribution is network access, not software. |
| SMS | Integrate | Twilio-class | 10DLC registration takes 2–4 weeks — **day-1 task**; STOP handling; dedicated number per business. |
| Email | Integrate | Postmark/SES-class transactional | Deliverability reputation is a full-time job. |
| Certified/physical mail | Integrate (Phase 2) | Lob/certified-mail-API-class | Statutory notice delivery proof without trips to the post office. |
| Accounting | Export-first, then integrate | CSV with account mapping in MVP → QuickBooks Online API sync Phase 2 | Never build a GL. CSV delivers 80% of value immediately. |
| Calendar | Integrate | ICS feed MVP → Google/Microsoft 2-way Phase 2 | Showings + maintenance windows. |
| Address validation | Buy | USPS/Google-class | Trivial to integrate, painful to build. |
| File/photo storage | Buy (infra) | S3-class + CDN | Commodity. |
| Smart locks/lockboxes | Integrate (Phase 2/3) | Per-device APIs | Self-showings (LEASE-08); one-time codes + entry logs. |
| Renter's insurance verification | Defer | Partner API later | Low value density v1. |
| **What we build** | — | — | The jurisdiction-rules engine and every statutory calculation, the ledger projection and its reconciliation, work-order lifecycle, comms threading, notification engine, inspection tooling, permissions, case files. The differentiated workflow layer no integration provides coherently for this segment. |

---

## 8. MVP Phasing

### Walking Skeleton (weeks 1–6)
One property → one unit → one lease → rent charge posts → tenant pays via processor sandbox → ledger updates → tenant submits ticket with photo → PM assigns tech → tech closes with photo → everything on one dashboard, every event in the audit log, one real SMS + one real email delivered. A thin end-to-end slice through all core architecture (entities, ledger, payments, notifications, files, roles) proving the risky seams before widening.

### Phase 1 — MVP: run the real portfolio (months 0–4)
PROP-01…06 · PAY-01…08, PAY-12 (+PAY-13 if Section 8 confirmed) · MAINT-01…07, MAINT-12 · COMM-01…06 · NOTIF-01…03 · ROLE-01…03, 05 · DOC-01…03 · RPT-01…04 · RISK-05, RISK-06 · jurisdiction config for current footprint states only · data migration + tenant activation campaign as a real workstream.

**Rationale:** for a 10–50 unit operator, value concentrates in rent collection + maintenance + communications — the three daily bleeding wounds. Leasing happens 10–20×/year; maintenance weekly; rent monthly. Explicitly in MVP despite temptation to cut: autopay (the collection-rate engine), vendor magic-link (vendor adoption dies without it), offline payment recording (Gene), approval thresholds (owner trust), audit logs (retrofitting is miserable), habitability auto-elevation and retaliation guard (cheap to build now, existential later).

### Phase 2 — Leasing + money polish (months 4–8)
Full LEASE stack (listings, syndication, applications, screening, adverse action, lease generation + e-sign, renewals, notice-to-vacate) · INSP-01…03 (deposit-defense machinery paired with the move-out volume leasing creates) · LEASE-12 make-ready · PAY-09/10/11/14 · MAINT-08/09/11 · QBO API sync · certified-mail API · RPT-05/06/07 · NOTIF-04/05 · showing scheduling · RISK-01/02/08.

### Phase 3 — Scale & polish (months 8–12+)
Preventive-maintenance depth · smart-lock self-showings · investor role + statements (ROLE-04, RPT-08) · tenant self-inspection (INSP-05) · INSP-06 punch lists · Spanish localization · insurance/claims module (RISK-07) · remaining RISK workflows · credit-reporting opt-in (PAY-15) · analytics depth (MAINT-10) · possible native tech app if PWA offline hits limits.

### Riskiest Assumptions → Cheap Validation
1. **Tenants adopt portal/autopay mid-lease** → pre-build: offer a one-time incentive to switch to a stopgap ACH link; measure conversion; design the incentive lever into the product.
2. **Vendors use magic-link work orders** → send 3 real vendors a mocked SMS link for a real job this month; watch.
3. **Processor underwriting clears in time** → apply week 1 with real docs; parallel fallback application.
4. **Jurisdiction-rules-as-config covers real statutory variance** → legal review of the config schema against the actual footprint states *before* building the engine.
5. **Owner abandons side channels** → "no-side-channel week" pilot in beta; instrument % comms in-platform from day one.
6. **10DLC/SMS and screening-provider approvals land on schedule** → all external applications submitted sprint 1; tracked as program risks.

---

## 9. Metrics & Instrumentation

**Activation:** Tenant — account → payment method → first payment or ticket in 30 days; north star = autopay enrolled. Owner — dashboard 3+ days in week 1; first mobile approval. PM — first template sent; first ticket triaged-to-closed. Tech — first job closed mobile with photo. Vendor — magic link opened → accepted (the gap between those two events is the friction measure).

**Engagement:** % rent via platform; autopay retention; portal vs. phone-logged tickets; SLA-compliant triage rate; templates-vs-freetext ratio; approvals actioned <24h; vendor link acceptance rate and median time-to-accept; invoice-upload rate.

**Outcomes:** mirror §2.2 — plus maintenance cost/unit/month, post-resolution satisfaction (one-tap rating), repeat-ticket rate, renewal rate, turnover cost per turn, days-vacant per turn.

**Event taxonomy from day one:** `payment_initiated/succeeded/failed/reversed`, `autopay_enrolled/canceled`, `charge_posted`, `late_fee_posted/waived`, `ticket_submitted` (source), `ticket_first_response`, `wo_created/assigned/dispatched`, `vendor_link_opened/accepted/declined`, `wo_scheduled/completed/verified/reopened`, `approval_requested/approved/denied` (+elapsed), `message_sent/delivered/failed/replied` (channel, template, actor), `application_started/submitted`, `screening_requested/returned`, `decision_recorded` (criteria_version), `adverse_action_sent`, `lease_sent/signed`, `inspection_started/completed/signed`, `disposition_generated/sent` (+days_before_deadline), `notice_generated/delivered` (method, proof_type), `login`/`magic_link_used` (role), `offline_sync_queued/flushed`, `notification_sent/opened` (category). Every event carries actor, role, entity IDs, property/state, channel, timestamp. A boring event table + weekly SQL dashboard suffices at this scale — but never skip capture.

---

## 10. Open Questions (gate final MoSCoW sign-off)

1. State/metro footprint today and the 24-month plan? (Seeds jurisdiction config + lease-template legal budget.)
2. In-house tech vs. all-vendor mix? (If all-vendor, offline tech app deprioritizes; magic-link becomes the whole maintenance edge.)
3. Who does bookkeeping today, in what system, cash or accrual? (Dictates export design and entity mapping.)
4. **Any Section 8/HCV tenants now or planned?** (If yes, PAY-13 is Must in Phase 1.)
5. How many LLCs, and do any have outside partners with distribution rights? (Entity model; whether the Priya persona is real.)
6. Current payment-method breakdown across tenants — how many Genes? (Sizes offline path + adoption campaign.)
7. What share of tenants are non-English-primary? (Spanish localization: Should vs. Must; which notices need attorney-approved translations.)
8. Are written screening criteria documented today? (If not, they must be authored with counsel before LEASE-04 ships — the product blocks on it.)
9. Who is on-call after hours today, and what's the real protocol? (Feeds NOTIF-05/MAINT-12.)
10. Lease templates: attorney-drafted per state already, or from scratch? (Legal cost + timeline dependency for LEASE-06.)
11. Deposit handling today: separate escrow accounts where required? Interest-bearing where required? (Any current non-compliance the software would memorialize?)
12. Appetite for tenant-facing fees (card pass-through, application fee amounts vs. state caps)?
13. Data-migration source of truth: what exists, and who owns cleanup labor?
14. Do key vendors demand fast pay? (If yes, Phase 3 bill-pay rises.)
15. Any intent to ever offer the platform to other landlords? (Officially a non-goal; the honest answer affects tenancy-architecture decisions that are cheap now and brutal later.)

## 11. Key Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Tenant adoption** (highest) | Collection/comms goals miss | Incentives; offline-first-class support; activation campaign as an owned launch workstream |
| Payment processor underwriting delay (multi-LLC KYB) | Launch slip 4–8 weeks | Apply week 1; parallel fallback provider |
| Fair-housing/screening compliance failure | Existential-cost lawsuit | Criteria versioning; enforced adverse action; counsel reviews the *workflow*, not just documents |
| SMS deliverability / 10DLC lag | Comms hub value collapses | Register early; email/portal fallback |
| Side-channel leakage (owner keeps texting from personal phone) | Audit-log value collapses | Make in-platform faster than native texting; measure % in-platform |
| Wrong jurisdiction config | Manufactures compliance failures at scale | Legal review per state config; effective-dated versioning; conservative defaults; human confirmation on dispositions |
| Custom-build TCO vs. off-the-shelf (Buildium/DoorLoop-class covers ~70% for $100–300/mo) | Sunk cost on a worse Buildium | Keep justifying via the differentiated 30% (magic links, jurisdiction rigor, evidence trail, data ownership); if scope creeps toward rebuilding Buildium badly — stop and buy |
| Key-person dependency (who fixes it in year 3?) | Orphaned platform | Hosting/maintenance plan and bus-factor answer documented before Phase 1 exit |
| Automation trust loss (one wrong auto-fee) | Regression to spreadsheets | Visible log + easy reverse on every automated action |

---

## 12. Traceability

Story IDs in §5 (PROP-, LEASE-, PAY-, MAINT-, COMM-, INSP-, DOC-, RPT-, NOTIF-, ROLE-, RISK-) are stable references. `06-backlog.md` cites them in its PRD/Feature column: the backlog row is the work order, the story here is the definition of done. Open Questions in §10 are carried into `07-decisions.md` as OQ-1…OQ-10 with the specific R-items each one gates; jurisdiction configs gate go-live per state.

---

## 13. Data Model (canonical entity names)

Use these names in Prisma and in conversation. Money fields are integer cents (suffix `Cents`). Every operational entity carries `propertyId`; every financial entity resolves to a `legalEntityId` through its property.

**Ownership & inventory** — `LegalEntity` (LLC or personal; owns properties, scopes reporting) · `Property` (address, geo, timezone, **state — drives every jurisdiction lookup**, acquisition date, mortgage/insurance/HOA/warranty records) · `Unit` (main house, ADU, duplex side; status machine; market rent; operational data: codes, appliances, filter sizes, shutoff locations) · `PropertyDocument`.

**People & tenancy** — `StaffUser` + `StaffPropertyAssignment` (roles-as-data; `propertyId = null` means all-properties, D-5) · `Tenant` · `Guarantor` · `Vendor` (trades, W-9, COI expiry, license, preferred rank) · `Lease` (parties, term, rent, deposit held, utility responsibility, status; MTM rollover rate) · `LeaseHold` (typed: SCRA, deceased, bankruptcy, dispute, payment plan, do-not-contact — with declared effects) · `Application` + `ScreeningDecision` (criteria version, decision-maker, timestamp — immutable).

**Money** — `Charge` · `Payment` (channel, incl. `offline_check` / `retail_cash`; `receivedByStaffId` required for offline) · `LedgerEntry` (**append-only; corrections are reversing entries**) · `Deposit` (a liability, never income) · `RecurringCharge` · `PayerAllocation` (the two-payer shape that makes HAP/tenant splits possible — settled at R-002 whether or not Section 8 is in scope).

**Maintenance** — `Ticket` (tenant-facing request; source: `portal` / `sms` / `phone_logged`) · `WorkOrder` (lifecycle: submitted → triaged → approved → assigned → scheduled → in progress → work complete → verified → invoiced → closed, plus `on_hold_warranty` and `waiting_on_tenant`) · `VendorLink` (signed, single-use, expiring — D-6) · `MaintenanceSchedule` (preventive/seasonal templates).

**Evidence & communication** — `Thread` + `Message` (portal / SMS / email / logged call; per tenancy, property, vendor, and work order) · `Notice` (type, generated PDF, **service method and delivery proof**, address of record as rendered) · `Inspection` + `InspectionItem` (condition, notes, photos with preserved timestamps; move-in items linked to their move-out counterparts) · `Document` · `AuditLog` (actor, timestamp, entity, before/after, reason code — unmodifiable by any role).

**Operations & configuration** — `Task` (**the only work queue**, D-9) · `ComplianceItem` (licenses, inspections, renewals, appeal windows; recurrence + completion log) · `JurisdictionRule` (versioned, effective-dated; the single source of every statutory number, D-4) · `Listing` · `NotificationPreference` + `Consent` (SMS/TCPA, notice-by-email — a distinct value from account email).

---

## 14. Simulated Adapters (D-7)

Three external capabilities are partner-gated or regulated, and all three are built against simulators first. The simulator is the primary adapter for this build and the contract fixture for a future real driver — the same approach the storage platform took with gate hardware.

| Adapter | Simulates | Why simulated first | Real driver |
|---|---|---|---|
| `SimulatedScreeningAdapter` | Applicant-initiated credit / criminal / eviction reports; returns seeded result sets incl. thin-file and mixed-record cases | FCRA-regulated and bureau-gated. The parts with legal consequence — criteria versioning, uniform application, decision audit, adverse-action generation — are fully testable without a bureau relationship, and testable against *adverse* cases a sandbox rarely provides | R-093, Phase 3 |
| `SimulatedESignAdapter` | Signer order, viewed/signed events, completion certificate, executed PDF hash | Keeps lease execution buildable before a vendor is chosen; the merge-field and addenda logic is the hard part and it is ours either way | R-093, Phase 3 |
| `SimulatedSyndicationAdapter` | Outbound listing feed, inbound leads with source attribution, delist acknowledgement | Listing networks require approved feed partnerships; lead-source attribution and delist-on-lease-up are testable locally | R-093, Phase 3 |

Each simulator ships with **fault injection** (timeout, malformed response, delayed webhook, partial failure) so the error paths are exercised in CI rather than discovered in production. No code outside the adapter boundary may assume a provider's response shape.

---

*This document contains no legal advice. All statutory references (grace periods, deposit deadlines, notice periods, FCRA / VAWA / SCRA / fair-housing obligations) vary by jurisdiction and require review by qualified counsel before the corresponding features are activated. This is a learning project.*

