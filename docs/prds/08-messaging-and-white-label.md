# 08 — Renter Text Messaging & White-Label PRD
## Tenant SMS Broadcast, Self-Service Messaging, Manual Application Review, White-Label Onboarding

| | |
|---|---|
| **Document status** | Draft v0.1 — not yet reviewed, nothing in it is built |
| **Date** | October 20, 2026 |
| **Prepared by** | Shane LaBounty (from a discovery conversation with a realtor prospect, ~20 rental properties) |
| **Source** | Claude Docs "Renter Text Messaging PRD" — https://claude.ai/artifact/XwdtN1toh2zR691rNDUfRJ |
| **Companion files** | `00-master-prd.md` · `06-backlog.md` · `07-decisions.md` (**overrides this document where they conflict**) · `../PROGRESS.md` |

> **On the numbering — read before appending anything.** The draft's IDs were written without checking the repo and **every one of them collides**: R-098 to R-122 are already built rows in `06-backlog.md` (highest is R-257), D-11 to D-16 are already settled in `07-decisions.md` (D-11 is *Stripe Billing drives recurring rent*; highest is D-308), and OQ-11/OQ-12 exist in the master PRD §10. Treat every R-, D- and OQ- number below as a **draft placeholder**. They are renumbered (R-258+, D-309+, OQ-13+) when the rows are appended to the backlog and decisions log, not before. Story IDs M1.1–M4.1 do not collide.

## 1. Context and problem

A realtor whose group manages 20 rental properties named two must-haves in a discovery conversation: broadcast SMS to all or selected renters, and the ability to change messages and settings himself without a developer. The current rental platform has Twilio wired in (D-1 stack) but only for transactional, system-triggered texts such as rent reminders and maintenance updates. There is no operator-composed messaging, no audience selection, and no self-service template editing.

This PRD adds operator messaging on top of the existing Twilio adapter, and makes templates, quiet hours and sender identity owner-editable so the operator never needs a code change to run day-to-day communications. A third ask surfaced in the same conversation: whether the platform can be offered to his group as a paid, white-labeled instance. That is scoped in the final section.

## 2. Goals, non-goals and success metrics

Goal: an operator can compose and send a text to every active renter, or to a filtered subset, in under two minutes, and can edit every recurring message the system sends without developer help.

**In scope**

- Broadcast SMS to all active renters across the portfolio or a single entity/property
- Targeted SMS by saved filter: property, unit, lease status, balance due, move-in/move-out window, maintenance ticket open, or hand-picked renters
- Operator-editable message templates with merge fields (first name, property, unit, amount due, due date, portal link)
- Operator-editable messaging settings: sender number, quiet hours, per-renter opt-out handling, default footer
- Delivery log per message and per renter, with status from Twilio (queued, sent, delivered, failed, opted out)
- Two-way: inbound replies land on the renter's record and raise a Task for the operator

**Out of scope (this PRD)**

- MMS / images
- Email broadcast (separate PRD; same audience engine should be reused)
- Automated drip campaigns or scheduling beyond "send now" and "send at"
- AI-drafted messages

**Success metrics**

| Metric | Target |
| --- | --- |
| Time from open composer to send (20-unit portfolio) | < 2 min |
| Operator-made template edits without a code change | 100% |
| Delivery rate to opted-in renters | > 97% |
| Messages sent outside quiet hours | 0 |
| Inbound replies routed to a Task | 100% |

## 3. Users and personas

The primary user is the rental owner-operator working from a phone between showings; the messaging and settings surfaces are designed mobile-first and verified on desktop second.

| Persona | Who | Device | What they need from this feature |
| --- | --- | --- | --- |
| Owner-operator | Realtor running a \~20-property group alongside a sales practice | Phone, mostly | Send a broadcast or targeted text in a few taps; edit templates and settings himself; see who got it and who replied |
| Office admin | Part-time assistant or bookkeeper | Desktop | Same composer and log; manages opt-outs and template library |
| Renter | Tenant on an active lease | Phone (SMS, no app) | Receives texts, can reply, can STOP/START; replies reach a person |
| Vendor | Maintenance contractor | Phone | Unchanged — existing magic-link flow; not an audience for broadcasts |

**Mobile-first acceptance criteria (owner surfaces)**

- Composer, audience picker, send confirmation and delivery log all usable one-handed at 375 px width with no horizontal scroll
- Audience filters are chips and bottom sheets, not multi-column tables
- Template editor: full-screen on mobile, merge fields inserted from a tap bar, live preview with sample renter data
- Send button requires a confirmation sheet showing recipient count and the rendered first message
- Installable as a PWA; messaging log and composer cached for last state
- Lighthouse mobile score >= 90 on composer and log routes (existing repo gate)

**Adjacent capability: applications.** Applicant intake and approve/decline exist in the master PRD against a simulated screening adapter; real screening is a go-live-gated backlog row. This PRD adds a manual-review path so the owner, not a screening vendor, makes the call: see requirement group C below. The audience engine exposes "applicants" as a segment so approved or declined applicants are texted from the same composer.

## 4. Requirements

**A. Broadcast and targeted send**

| ID | Requirement | Priority |
| --- | --- | --- |
| A1 | Compose a message up to 1,600 chars; show segment count and estimated cost before send | Must |
| A2 | Audience = All active renters (default), or filter by entity, property, unit, lease status, balance due > $0, move-in/out within N days, open maintenance ticket, applicant status | Must |
| A3 | Hand-pick or remove individual recipients after filtering | Must |
| A4 | Save a filter as a named audience (e.g. "Oak St duplexes") | Should |
| A5 | Send now or schedule for a date/time in property-local time | Must |
| A6 | Confirmation sheet shows recipient count, first rendered message, and quiet-hours warning | Must |
| A7 | Per-recipient delivery status synced from Twilio status callbacks | Must |
| A8 | Inbound replies attach to the renter record and create a Task in the existing single Task queue | Must |
| A9 | Resend to failed recipients only | Should |

**B. Self-service templates and settings (no developer)**

| ID | Requirement | Priority |
| --- | --- | --- |
| B1 | Template library: create, edit, duplicate, archive; versioned with who/when | Must |
| B2 | Merge fields: first name, property name, unit, amount due, due date, portal link, owner name, owner phone | Must |
| B3 | Every system-triggered text (rent reminder, late notice, maintenance update, lease renewal, applicant decision) maps to an editable template; owner edits replace the default | Must |
| B4 | Live preview with a real renter's data; validation blocks send if a merge field is empty for any recipient | Must |
| B5 | Settings page: sender number, business name in footer, quiet hours (default 8 pm–8 am local), opt-out keyword handling, default reply-to Task assignee | Must |
| B6 | Role gate: Owner and Admin can edit templates/settings; Staff can send from approved templates only | Should |

**C. Application review and approve/decline (manual-first)**

| ID | Requirement | Priority |
| --- | --- | --- |
| C1 | New application creates a Task assigned to the owner with applicant summary, uploaded docs, and any screening result if a vendor is connected | Must |
| C2 | Owner reviews on mobile: swipeable doc viewer, income vs rent ratio shown, notes field | Must |
| C3 | Actions: Approve, Decline, Request more info. Decline requires a reason from a configurable list; reason stored for fair-housing audit | Must |
| C4 | Each action fires the matching editable template to the applicant by SMS (and email if present) | Must |
| C5 | Approve converts applicant to a lease draft in the existing lease flow | Must |
| C6 | Screening vendor is an optional input, never a gate; manual override always available | Must |
| C7 | Audit log of every decision: who, when, reason, template version sent | Must |

## 5. Epics and user stories

Story IDs continue the master PRD's §5 numbering convention; backlog rows R-098 onward map to these.

**Epic M1 — Operator messaging**

- M1.1 As an owner, I pick "All renters" and send a water-shutoff notice from my phone in under two minutes.
- M1.2 As an owner, I filter to renters with a balance due and send a friendly reminder.
- M1.3 As an owner, I schedule a holiday office-hours text for 9 am tomorrow, property-local.
- M1.4 As an admin, I see per-renter delivery status and resend to the three that failed.
- M1.5 As a renter, I reply to a text and a person responds; replying STOP ends messages and the system confirms.

**Epic M2 — Self-service templates and settings**

- M2.1 As an owner, I reword the rent-reminder text and the next nightly job uses my version.
- M2.2 As an owner, I set quiet hours and the system holds any send until the window opens.
- M2.3 As an owner, I change the sender name and footer without contacting anyone.
- M2.4 As an admin, I restore a previous template version.

**Epic M3 — Manual application review**

- M3.1 As an owner, a new application shows up as a Task on my phone with the docs attached.
- M3.2 As an owner, I approve and the applicant gets the approval text and a lease draft is created.
- M3.3 As an owner, I decline with a reason from the list and the decline text goes out; the reason is logged.
- M3.4 As an owner, I request pay stubs and the applicant gets a text with an upload link.

**Epic M4 — Multi-tenant and white-label (see final section)**

- M4.1 As Shane, I provision a new organization for a customer with its own branding, sender number and data boundary.

## 6. Data model additions

All new tables carry `organizationId` so the white-label path (last section) is a column, not a rewrite. Money stays integer cents; timestamps UTC.

| Table | Key fields | Notes |
| --- | --- | --- |
| `MessageTemplate` | id, orgId, key (enum: rent\_reminder, late\_notice, maintenance\_update, lease\_renewal, applicant\_approved, applicant\_declined, applicant\_more\_info, custom), name, body, version, createdBy, archivedAt | One row per version; `key` + `isActive` resolves the current one |
| `Audience` | id, orgId, name, filterJson, createdBy | Saved filters (A4) |
| `Broadcast` | id, orgId, templateId?, body, audienceSnapshotJson, scheduledFor, sentAt, status, createdBy | Snapshot freezes who was targeted |
| `BroadcastRecipient` | id, broadcastId, renterId, phone, renderedBody, twilioSid, status, statusAt, errorCode | One row per renter per send |
| `InboundMessage` | id, orgId, renterId?, fromPhone, body, twilioSid, receivedAt, taskId | Unmatched numbers still logged |
| `MessagingSettings` | orgId, senderNumber, businessName, footer, quietStart, quietEnd, timezoneSource, defaultTaskAssigneeId | One row per org |
| `RenterContactPref` | renterId, smsOptIn, optOutAt, optOutSource | Set by STOP/START webhooks and by admin |
| `ApplicationDecision` | id, applicationId, decision (approved/declined/more\_info), reasonCode, notes, decidedBy, decidedAt, templateVersionSent | Fair-housing audit trail (C7) |
| `Organization` | id, name, slug, brandJson, plan, status | Exists conceptually as "entity"; promote to a true tenant root |

Existing `Task` entity gains `kind = inbound_sms | application_review` — no new queue.

## 7. Compliance, consent, rate limits and quiet hours

Texting renters is regulated (TCPA in the US, plus carrier 10DLC registration); the system enforces the rules so the owner cannot accidentally break them.

| Area | Rule the system enforces |
| --- | --- |
| Consent | Renter `smsOptIn` must be true to receive a broadcast; captured at lease signing (checkbox, timestamped) or via START reply. Transactional notices required by the lease (e.g. entry notice) may send regardless and are flagged as such in the template `key` |
| Opt-out | STOP, UNSUBSCRIBE, CANCEL, END, QUIT set `optOutAt`; auto-reply confirms; START re-enables. Opted-out renters are excluded from audiences and shown as a count on the confirmation sheet |
| Quiet hours | Default 8 pm–8 am in the property's local time zone; a scheduled send inside the window is held to the next open minute; owner can override per send with a logged reason |
| 10DLC | Sender number must be a registered A2P 10DLC number under the organization's brand; unregistered numbers cannot send broadcasts (settings page shows registration status from Twilio) |
| Rate limits | Sends fan out through a queue at <= 1 msg/sec per number (Twilio long-code limit); UI shows estimated completion for large audiences |
| Identification | Every broadcast ends with the configurable footer (business name + "Reply STOP to opt out") |
| Fair housing | Applicant decision reasons come from a fixed list reviewed by counsel (OQ); free-text notes are internal only and never sent to the applicant |
| Retention | Message bodies and delivery logs retained 7 years with the lease record; phone numbers are the only PII stored, no card/bank/SSN (existing invariant) |
| Audit | Template edits, settings changes, quiet-hours overrides and application decisions all write to the existing audit log with actor and timestamp |

## 8. White-label and paid onboarding

Recommendation: offer the realtor's group a hosted, white-labeled organization on the existing codebase rather than a separate deployment. The build already isolates data by entity and keeps vendors behind adapters, so multi-tenancy is a schema promotion plus a per-org integrations layer, not a fork.

**How it works at 20 properties**

| Layer | Today (single owner) | White-label (per organization) |
| --- | --- | --- |
| Data boundary | Entities under one implicit owner | `Organization` is the tenant root; every row scoped by `orgId`; Prisma middleware enforces it |
| Branding | Hardcoded | `brandJson`: logo, colors, business name, support email, custom domain via Vercel (e.g. `portal.hisgroup.com`) |
| Payments | One Stripe account, test mode | Stripe Connect: each org onboards its own connected account; rent flows directly to the org's bank; platform fee optional |
| SMS | One Twilio number | Per-org Twilio subaccount and A2P 10DLC brand registration; sender number stored in `MessagingSettings` |
| Email | One Resend domain | Per-org verified sending domain |
| One-off integrations | None | `OrgIntegration` table: provider (quickbooks, screening vendor, e-sign, syndication, custom), credentials (encrypted), status, config; each adapter reads its org's row |
| Jurisdiction rules | Texas seeded | Per-org state selection from the versioned rules config; Oklahoma added for this customer |
| Auth | Auth.js, single org | Users belong to one or more orgs; role per org (Owner, Admin, Staff) |

**Onboarding checklist (what Shane runs per new customer)**

1. Create the organization and invite the owner (M4.1)
2. Owner completes Stripe Connect onboarding from the settings page
3. Provision Twilio subaccount, register 10DLC brand and campaign, assign number
4. Verify email sending domain
5. Import properties, units, renters and active leases from CSV (template provided)
6. Connect any one-off integrations (QuickBooks first, if his group uses it)
7. Owner reviews and edits all message templates
8. Test send to owner's own phone; test $1 payment; go live

**Draft pricing for a 20-property group (revised)**

Recommended offer: $99/month flat plus a $500 one-time onboarding fee, SMS and payment processing passed through at cost. This sits above the DIY tools ($0–30) and near Buildium's entry plan ($58), justified by white-label branding, custom workflows and direct support.

| Line item | Draft price | Basis |
| --- | --- | --- |
| Platform subscription | $99/month | Flat up to 25 units; includes QuickBooks sync |
| Onboarding | $500 one-time | Data import, Stripe Connect, 10DLC, templates, QBO mapping; covers part of \~15 h setup |
| SMS | Pass-through, \~$0.01/segment + \~$2/month number | ≈ $1.50/month at 20 renters |
| Rent payments (ACH / card) | Pass-through Stripe | Owner chooses who pays |
| Platform fee on payments | Optional 0.25% via Stripe Connect | Lever if margin is needed later |
| Additional units | $4/unit/month above 25 |  |

Year one from this customer: 12 × $99 + $500 onboarding = $1,688.

**Competitor pricing (verified Oct 2026)**

| Product | Entry price | Notes |
| --- | --- | --- |
| Buildium | $58/month (Essential) | Full suite; per-portfolio tiers |
| TenantCloud | $12/month | Unlimited units; ACH is a paid add-on |
| RentRedi | $12/month annual, $29.95 monthly | Unlimited units; mobile-first; accounting via REI Hub |
| Avail, Innago, TurboTenant | Free tier | Paid upgrades for some features |

Sources: [Buildium](https://www.buildium.com/), [Landlordspan comparison](https://landlordspan.com/resources/best-property-management-software-small-landlords), [Buildium small-business roundup](https://www.buildium.com/blog/best-property-management-software-for-small-business/), [Shuk Rentals](https://www.shukrentals.com/learn/property-management-software-for-small-landlords).

**Feature comparison and gaps**

Our build covers the core loop; the real gaps are the vendor-backed features still running on simulated adapters, plus a few conveniences competitors treat as standard. Competitor feature columns reflect each product's typical published feature set, not a line-by-line audit.

| Feature | Ours | Buildium | TenantCloud | RentRedi | Gap? |
| --- | --- | --- | --- | --- | --- |
| Online rent (ACH/card), autopay | Built (Stripe, test mode) | Yes | Yes (ACH add-on) | Yes | Go-live only |
| Accounting / ledger | Built, append-only | Yes, full GL | Yes | Via REI Hub | — |
| QuickBooks sync | PRD drafted | Export | Yes | Via integration | Build R-115–R-120 |
| Maintenance requests + vendors | Built, vendor magic links | Yes | Yes | Via integration | — |
| Applications | Built | Yes | Yes | Yes | — |
| Manual approve/decline | PRD drafted | Yes | Yes | Yes | Build R-107–R-108 |
| Tenant screening (credit/background) | Simulated | Yes | Yes | Yes | **Not a gap: manual review is the default (D-11); vendor optional later** |
| E-signature leases | Simulated | Yes | Yes | Yes | **Gap: real vendor** |
| Listing syndication | Simulated | Yes | Yes | Yes | **Gap: real vendor** |
| Tenant messaging | Transactional only | Yes | Yes | In-app | Build M1 (this PRD) |
| SMS broadcast / targeted | PRD drafted | Limited | Limited | In-app, not SMS | **Our differentiator** |
| Owner-editable templates | PRD drafted | Partial | Partial | No | **Differentiator** |
| Tenant mobile app | Responsive web | Yes | Yes | Yes, native | **Not a gap: mobile web is the decision** |
| Rent credit reporting | No | Add-on | Yes | Yes | **Gap** |
| Renters insurance offer | No | Yes | Yes | Yes | Gap (low priority) |
| Owner statements / owner portal | Not confirmed | Yes | Yes | No | **Gap: confirm** |
| 1099 / tax reports | No | Yes | Yes | Via REI Hub | Gap (QBO covers it) |
| White-label / custom domain | PRD drafted | No | No | No | **Differentiator** |
| Custom workflows on request | Yes (it's ours) | No | No | No | **Differentiator** |

Priority gaps to close before he's live: real e-sign vendor and confirming owner statements. Rent credit reporting and renters insurance can follow.

**E-signature vendor recommendation**

Recommendation: SignWell API now (pay-as-you-go), with self-hosted DocuSeal as the path once several white-label orgs are live. At 20 units the group signs roughly 10–20 leases a year, so per-document cost is negligible.

| Vendor | Price | Fit |
| --- | --- | --- |
| SignWell API | Free monthly allowance, then \~$0.85/document | Recommended now; clean API, pay-as-you-go |
| BoldSign | Free tier, low per-envelope | Viable alternative |
| DocuSeal (open source) | $0 software, \~$20–50/month hosting | Best for multi-org white-label; full branding control |
| Dropbox Sign API | From \~$40/month plus overage | More than needed |
| DocuSign API | From $50/month for 40 envelopes | Overkill at this size |

Sources: [GoodSign API pricing comparison](https://goodsign.io/blog/eSignature-API-Pricing), [Signbee pricing comparison](https://signb.ee/blog/e-signature-api-pricing-comparison-2026), [TurboDocx API comparison](https://www.turbodocx.com/best-esignature-api-comparison).

Implementation: replace the simulated e-sign adapter with a SignWell adapter behind the existing interface; credentials stored per org in `OrgIntegration` (provider = esign) so each white-label customer can bring its own account or use the platform's. Backlog: R-121 SignWell e-sign adapter (M, depends on R-111, phase 5). Decision D-16: SignWell first, DocuSeal when org count justifies self-hosting.

**Risks**

- Multi-tenant promotion touches every query; do it before the second customer, not after
- 10DLC registration takes days to weeks per brand; start it at contract signing
- Supporting a paying customer means on-call, backups and a status page — operational cost, not just build cost

## 9. Backlog rows, decisions and open questions

**Backlog additions (append to `docs/prds/06-backlog.md`)**

| # | ID | Item | PRD/Feature | Size | Depends on | Phase |
| --- | --- | --- | --- | --- | --- | --- |
| 98 | R-098 | Organization as tenant root + orgId scoping middleware | M4.1 | L | — | 4 |
| 99 | R-099 | MessageTemplate CRUD + versioning + merge-field renderer | B1–B4 | M | R-098 | 4 |
| 100 | R-100 | MessagingSettings page (mobile-first) | B5–B6 | S | R-098 | 4 |
| 101 | R-101 | Audience filter engine + saved audiences | A2–A4 | M | R-098 | 4 |
| 102 | R-102 | Broadcast composer + confirmation sheet (mobile-first) | A1, A5, A6 | M | R-099, R-101 | 4 |
| 103 | R-103 | Send queue, Twilio status callbacks, delivery log, resend-failed | A7, A9 | M | R-102 | 4 |
| 104 | R-104 | Inbound webhook → renter match → Task; STOP/START handling | A8, consent | M | R-100 | 4 |
| 105 | R-105 | Quiet-hours hold + override with reason | compliance | S | R-103 | 4 |
| 106 | R-106 | Map all system-triggered texts to editable templates | B3 | M | R-099 | 4 |
| 107 | R-107 | Application review Task + mobile doc viewer | C1–C2 | M | R-098 | 4 |
| 108 | R-108 | Approve / decline / more-info actions + ApplicationDecision audit | C3–C7 | M | R-107, R-099 | 4 |
| 109 | R-109 | Stripe Connect per-org onboarding | white-label | M | R-098 | 5 |
| 110 | R-110 | Twilio subaccount + 10DLC per org | white-label | S | R-098 | 5 |
| 111 | R-111 | OrgIntegration table + encrypted credential store + adapter lookup | white-label | M | R-098 | 5 |
| 112 | R-112 | Branding config + custom domain | white-label | S | R-098 | 5 |
| 113 | R-113 | CSV import for properties/units/renters/leases | onboarding | M | R-098 | 5 |
| 114 | R-114 | Oklahoma jurisdiction rules config | onboarding | S | — | 5 |

**Decisions (append to `07-decisions.md`)**

- D-11: Manual review is the default application path; screening vendors are optional inputs, never gates.
- D-12: White-label = multi-tenant on one deployment, not per-customer forks.
- D-13: Each org brings its own Stripe Connect account and Twilio number; the platform never pools customer funds.

**Open questions for the realtor**

- [ ] OQ-11: Does his group run on QuickBooks today? (Drives the separate QuickBooks sync PRD's priority.)
- [ ] OQ-12: Which properties are in Oklahoma vs other states? (Jurisdiction config.)
- [ ] OQ-13: Does he want staff to send free-form texts, or only from approved templates?
- [ ] OQ-14: Decline-reason list — review with counsel before go-live.
- [ ] OQ-15: Willingness to pay per unit per month, and whether onboarding fee is acceptable.
