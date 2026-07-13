# Atlas — Primitive API Spec

**Status:** Draft v1 (for review)
**Date:** 2026-07-13
**Owner:** Adrian
**Maps to:** `atlas-system-design.md` (§3.2 API contract, §1.1 primitive taxonomy); Project Plan §7 (hub primitive additions).

The public **tenant contract**: ~23 primitives across the three hubs — **Guest**, **Ops**, **Marketing** — plus cross-cutting concerns. Every tenant (A-List included) uses the same contract; there are no private hooks.

## Conventions

- **Transport:** REST/JSON under `/v1`; the venue dashboard read layer additionally exposes GraphQL. Internal calls are in-process in the MVP monolith and become gRPC/events when a context is extracted.
- **Auth:** per-tenant OAuth2 client-credentials → scoped bearer tokens. Scopes are named `hub:primitive:action` (e.g. `guest:evidence:write`). Consumer-agent (MCP) tokens additionally carry a **guest consent scope**.
- **Tenancy:** every request is tenant-bound; Postgres RLS enforces isolation. `tenant_id` is never a request parameter — it comes from the token.
- **Idempotency:** all mutating calls accept an `Idempotency-Key` header; booking/pay require it.
- **Evidence:** the **Evidence** column names what affinity signal, if any, a call emits. `evidence:write` is the **only** path into the taste graph.
- **MCP:** ✅ = exposed as an MCP tool; (C) consumer-side, (T) tenant-side.
- **MVP:** ✅ = in the Phase 01/02 build; ○ = later.

---

## GUEST HUB (8)

### 1. Identity & Profile — `guest:identity`
The unified guest profile; provisional and resolved identities; merges.

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `POST /v1/guests` | Create guest (provisional ok) | `guest:identity:write` | — | — | ✅ |
| `GET /v1/guests/{id}` | Resolved profile | `guest:identity:read` | — | ✅(T) | ✅ |
| `POST /v1/guests/{id}/merge` | `merge_identities(surviving, absorbed[])` on verified phone/email; card-fingerprint / wallet corroboration | `guest:identity:merge` | — | — | ✅ |
| `POST /v1/guests/{id}/links` | Attach an identity link (phone, email, spotify_id, card_fingerprint, wallet) | `guest:identity:write` | — | — | ✅ |

Every merge is appended to `identity_merge_log` (reversible, auditable).

### 2. Consent Ledger — `guest:consent`
Hard dependency of every evidence write. No grant → no evidence.

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `POST /v1/consent` | Record a grant (scope, basis, connector) | `guest:consent:write` | — | — | ✅ |
| `DELETE /v1/consent/{id}` | Revoke (starts erasure of dependent derived rows) | `guest:consent:write` | — | — | ✅ |
| `GET /v1/guests/{id}/consent` | Active grants + basis | `guest:consent:read` | — | — | ✅ |

### 3. Taste Connectors — `guest:connectors`
OAuth + webhook plumbing that turns external accounts into evidence. Progressive onboarding (one connector at signup, earn the rest at moments of value; 30-second quiz fallback).

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `POST /v1/connectors/{provider}/authorize` | Start OAuth (spotify, instagram, stripe, square, klaviyo) | `guest:connectors:write` | — | — | ✅ |
| `POST /v1/connectors/{provider}/callback` | Complete OAuth → schedule sync | `guest:connectors:write` | — | — | ✅ |
| `POST /v1/connectors/quiz` | Zero-connector taste quiz | `guest:connectors:write` | affinity | — | ✅ |
| `POST /v1/webhooks/{provider}` | Signed inbound (Stripe/Square/Klaviyo) → normalise → evidence | (signature) | affinity | — | ✅ |

### 4. Taste Graph / Affinity — `guest:evidence`, `guest:affinity`
The append-only evidence log and the derived, decay-aware, mute-respecting graph.

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `POST /v1/evidence` | **The only graph write.** Append affinity evidence (subject, signal, weight, provenance, consent_grant_id, dedupe_key) | `guest:evidence:write` | affinity | — | ✅ |
| `GET /v1/guests/{id}/affinity` | Resolved taste (mutes + time-decay applied) | `guest:affinity:read` | — | ✅(T) | ✅ |
| `POST /v1/guests/{id}/mutes` | Hard "no" (overrides all) | `guest:affinity:write` | affinity(mute) | ✅(C) | ✅ |

### 5. Crew Graph — `guest:crew`
Crew is an **input, not an invite** — changing the crew re-runs recommendations. Crew affinity is **not** the average of members; the blend is learned (W2).

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `POST /v1/crews` | Create crew | `guest:crew:write` | — | ✅(C) | ✅ |
| `PUT /v1/crews/{id}/members` | Add/remove members → recompute `crew_affinity` | `guest:crew:write` | crew | ✅(C) | ✅ |
| `GET /v1/crews/{id}/affinity` | Blended crew taste (MVP heuristic; learned later) | `guest:crew:read` | — | ✅(C) | ✅ |

### 6. Entitlement Wallet — `guest:entitlements`
Perks, tickets, loyalty credits — agent-callable.

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `GET /v1/guests/{id}/entitlements` | Wallet contents | `guest:entitlements:read` | — | ✅(C/T) | ✅ |
| `POST /v1/entitlements` | Grant (perk/ticket/credit) | `guest:entitlements:write` | — | — | ✅ |
| `POST /v1/entitlements/{id}/redeem` | Redeem (idempotent) | `guest:entitlements:write` | loyalty | ✅(T) | ○ |

### 7. Loyalty — `guest:loyalty`
Cross-venue loyalty; revealed preference feeds the graph.

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `GET /v1/guests/{id}/loyalty` | Standing, credits | `guest:loyalty:read` | — | ✅(C) | ○ |
| `POST /v1/loyalty/accrue` | Accrue from a visit/spend | `guest:loyalty:write` | loyalty | — | ○ |

### 8. Trust & Reputation — `guest:trust`
No-show/behaviour signal for demand routing and door decisions.

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `GET /v1/guests/{id}/trust` | Trust score + factors | `guest:trust:read` | — | ✅(T) | ○ |
| `POST /v1/trust/events` | Record no-show / positive signal | `guest:trust:write` | — | — | ○ |

---

## OPS HUB (8)

### 9. Bookings — `ops:bookings`
State machine: `held → confirmed → seated → closed / cancelled`. ACID; booking is a paid action and weighs most in the graph.

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `GET /v1/venues/{id}/availability?date=&party=&crew=` | Crew-aware, taste-ranked inventory | `ops:bookings:read` | — | ✅(C) | ✅ |
| `POST /v1/bookings` | Hold → confirm (`Idempotency-Key` required) | `ops:bookings:write` | booking | ✅(C) | ✅ |
| `POST /v1/bookings/{id}/cancel` | Cancel / release hold | `ops:bookings:write` | — | ✅(C) | ✅ |

### 10. Inventory & Floor Map — `ops:inventory`
Tables, tickets, floor geometry.

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `GET /v1/venues/{id}/inventory` | Tables/tickets, capacity, min-spend | `ops:inventory:read` | — | ✅(T) | ✅ |
| `PUT /v1/inventory/{id}` | Upsert inventory item | `ops:inventory:write` | — | — | ✅ |
| `GET /v1/venues/{id}/floormap` | Floor geometry | `ops:inventory:read` | — | — | ○ |

### 11. Deposits & Minimums — `ops:deposits`
Capability inside Booking; deposit/minimum rules resolved before doors.

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `POST /v1/bookings/{id}/deposit` | Compute + hold deposit / minimum | `ops:deposits:write` | — | — | ✅ |

### 12. Split-Pay & Payments — `ops:payments`
Stripe rails; each crew member's share locked before doors.

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `POST /v1/bookings/{id}/split-pay` | Create split group + per-share PaymentIntents (Stripe idempotency keys) | `ops:payments:write` | — | ✅(C) | ✅ |
| `GET /v1/bookings/{id}/payments` | Per-share status | `ops:payments:read` | — | ✅(C) | ✅ |
| `POST /v1/webhooks/stripe` | Signed payment events | (signature) | — | — | ✅ |

### 13. Tab / POS Sync — `ops:tab`
Square POS → spend joins the guest profile (closes booking → spend → CRM).

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `POST /v1/webhooks/square` | Tab open/close, line items → spend evidence | (signature) | spend | — | ✅ |
| `GET /v1/bookings/{id}/tab` | Reconciled tab | `ops:tab:read` | — | ✅(T) | ✅ |

### 14. Demand Routing — `ops:routing`
Re-ranks recommendations for the crew (size, blended taste, budget, availability) and routes to the right room.

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `POST /v1/routing/rank` | Crew-adjusted ranking of rooms/inventory | `ops:routing:read` | — | ✅(C) | ✅ |

### 15. Door List / Check-in — `ops:door`
Capability inside Floor; arrival + entitlement check.

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `GET /v1/venues/{id}/doorlist?date=` | Tonight's list + entitlements | `ops:door:read` | — | ✅(T) | ○ |
| `POST /v1/door/checkin` | Mark arrival (→ attendance evidence) | `ops:door:write` | attend | ✅(T) | ○ |

### 16. Closeout / Settlement — `ops:closeout`
Nightly reconciliation + take-rate metering.

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `POST /v1/venues/{id}/closeout` | Reconcile night → `usage_event` (take-rate) | `ops:closeout:write` | — | — | ○ |

---

## MARKETING HUB (7)

### 17. Audience Studio — `mkt:audiences`
Build a segment in clicks; returns count **and** estimated revenue ("123 guests love Afro House and haven't visited in 4 months… est. $146k. Reach them?"). Delivery is discovery, never a blast.

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `POST /v1/audiences:query` | Segment (predicates over affinity/spend/recency/geo) → count + est. revenue | `mkt:audiences:read` | — | ✅(T) | ✅ |
| `POST /v1/audiences` | Save a reusable audience | `mkt:audiences:write` | — | — | ○ |

### 18. Discovery & Recommendations — `mkt:discovery`
"Spotify for nights out": surfaces the right experience to the right guest as a discovery, not an ad.

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `GET /v1/guests/{id}/recommendations?context=` | Ranked events/venues/tables (mutes + decay + budget/availability filters) | `mkt:discovery:read` | — | ✅(C) | ✅ |
| `POST /v1/recommendations:crew` | Crew-blended recommendations | `mkt:discovery:read` | — | ✅(C) | ✅ |

### 19. Lifecycle / CRM — `mkt:lifecycle`
Makes the venue's existing stack (Klaviyo) smarter — a delivery rail, not a replacement.

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `POST /v1/campaigns` | Push discovery notification to an audience via Klaviyo | `mkt:lifecycle:write` | — | — | ✅ |
| `GET /v1/campaigns/{id}` | Delivery + conversion | `mkt:lifecycle:read` | — | — | ○ |

### 20. Attribution — `mkt:attribution`
Closes the Instagram-ad → signup → booking loop; every link carries venue/campaign ID.

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `POST /v1/attribution/link` | Mint attributed venue/campaign link (incl. venue-link web booking) | `mkt:attribution:write` | — | — | ✅ |
| `GET /v1/venues/{id}/funnel` | Reach → signup → booking → spend | `mkt:attribution:read` | — | ✅(T) | ○ |

### 21. Winback / Relationship Monitoring — `mkt:winback`
Notices lapse, finds the *why*, waits for the right moment (favourite DJ announced, birthday) and surfaces it as discovery.

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `GET /v1/venues/{id}/at-risk` | Lapsing guests + likely cause | `mkt:winback:read` | — | ✅(T) | ○ |
| `POST /v1/winback/trigger` | Arm a winback on a signal (e.g. artist announce) | `mkt:winback:write` | — | — | ○ |

### 22. Reporting & Benchmarks (BI) — `mkt:reporting`
Executive intelligence: demand trends, community/cohort views, venue-to-venue benchmarks. Served from the OLAP warehouse, not OLTP.

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `GET /v1/reports/{metric}?venue=&range=` | Benchmarks (repeat rate, spend, lead time, artist performance…) | `mkt:reporting:read` | — | ✅(T) | ✅ |
| `POST /v1/reports:cohort` | Community/cohort segmentation | `mkt:reporting:read` | — | ✅(T) | ○ |
| GraphQL `dashboard` | Dashboard read layer (over-fetch-averse) | `mkt:reporting:read` | — | — | ○ |

### 23. Entities / Catalog — `mkt:entities`
Cold-start, non-personal: artists, events, venues, lineups. The only place purchased/scraped data is allowed.

| Endpoint | Purpose | Scope | Evidence | MCP | MVP |
|---|---|---|---|---|---|
| `GET /v1/entities?kind=&q=` | Search catalog (OpenSearch-backed) | `mkt:entities:read` | — | ✅(C) | ✅ |
| `PUT /v1/entities/{id}` | Upsert artist/event/venue metadata | `mkt:entities:write` | — | — | ✅ |

---

## Cross-cutting

| Concern | Mechanism |
|---|---|
| **Metering / billing** | `usage_event` emitted by Bookings + Closeout (and optionally per API/MCP call) → take-rate billing. |
| **MCP gateway** | Two-sided: the ✅(C)/✅(T) tools above compose the consumer and tenant toolkits. Same primitives, different auth scope + consent gate. |
| **Rate limiting** | Per-tenant limits (Redis) so no tenant — including A-List — starves others. |
| **Idempotency** | `Idempotency-Key` on all mutations; enforced on booking/pay. |
| **Observability** | Every primitive call traced (OpenTelemetry); booking-path latency/error-rate, evidence lag, connector failure, DLQ depth alarmed. |

---

## Primitive count

**23** = Guest 8 (1–8) + Ops 8 (9–16) + Marketing 7 (17–23). Additions from Plan §7 (promoter tracking, drop pages, referral links, etc.) land as **capabilities inside** these primitives, keeping the "23 primitives, one contract" architecture stable.
