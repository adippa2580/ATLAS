# Atlas — System Design

**Status:** Draft v1 (for review)
**Date:** 2026-07-13
**Author:** Adrian Di Pietrantonio
**Scope:** Atlas the platform — the multi-tenant substrate that powers A-List (first tenant) and, later, venue tenants and agent traffic.
**Inputs:** `Atlas_Project_Plan.md` (v1.1), *Atlas — Business Intelligence for Hospitality* (Jul 2026), *A-List Is the Engine* (pitch order), *A-List Deck v1*.
**Convention:** items marked **[ASSUMPTION]** are design defaults chosen to move forward; confirm at the next checkpoint.

---

## 0. TL;DR

Atlas is a **multi-tenant intelligence-and-booking platform** exposed as ~23 **primitives** (versioned public APIs) grouped into three hubs — **Guest**, **Ops**, **Marketing**. Every tenant, including A-List, consumes the *same* public contract; there are no private hooks.

The load-bearing idea is that **the taste graph is exhaust**: guests and venues do normal things (connect Spotify, book a table, run a tab), connectors turn those actions into **append-only affinity evidence**, and Atlas recomputes that evidence into per-tenant intelligence. The platform therefore separates cleanly into three planes:

1. **Transactional plane (OLTP)** — identity, bookings, entitlements, payments, floor ops. Correctness-critical, low-latency, strongly consistent.
2. **Evidence plane (streaming/lake)** — the append-only affinity log and derived taste graph. High-volume, eventually-consistent, provenance- and consent-tagged.
3. **Intelligence plane (OLAP + serving)** — venue BI/benchmarks, audience matching, recommendations, and the two-sided MCP agent surface.

**MVP posture (Phase 01, Aug–Sep 2026):** one deployable **modular monolith** exposing primitive APIs, Aurora Postgres as the OLTP + first-cut graph store, an S3 evidence lake fed by a single event stream, Redis for hot serving, and a thin MCP gateway. Everything is built so that *scaling means adding partitions/consumers/services, not re-architecting.*

---

## 1. Requirements

### 1.1 Functional (what Atlas must do)

Grouped by the three hubs (the primitive taxonomy). Each is a primitive or a capability inside one.

| Hub | Primitives (MVP subset in **bold**) |
|---|---|
| **Guest** | **Identity & profile**, **taste connectors**, **taste graph / affinity**, crew graph, entitlement wallet, trust/reputation, loyalty, consent ledger |
| **Ops** | **Bookings**, **table/inventory & floor map**, **split-pay & payments (Stripe)**, deposits/minimums, tab/POS sync (Square), demand routing, door list, closeout |
| **Marketing** | **Audience Studio (segmentation)**, **discovery/recommendations**, lifecycle/CRM (Klaviyo), attribution, winback, drops/referral, **reporting/BI** |

Cross-cutting:
- **Connectors** — Stripe, Spotify, Instagram, Klaviyo, Square (first five). Each writes evidence through primitives; none is a bespoke pipeline.
- **Identity resolution** — merge provisional and connector-linked identities on verified phone/email (`merge_identities`), corroborated by Stripe card fingerprint / Wallet-pass device ID.
- **Two-sided MCP** — consumer agents (Claude/ChatGPT/Perplexity) *and* tenant-side agents call the same toolkit.
- **Cross-tenant intelligence** — anonymised aggregates above minimum tenant/guest thresholds.

### 1.2 Non-functional

| Attribute | MVP target | Growth target | Notes |
|---|---|---|---|
| Consumers (A-List) | 10k–50k | Millions | Wedges: venue distribution, artists, groups, discovery |
| Tenants (venues) | 1–10 (anchors, one city) | 100s across cities | Per-tenant graph isolation required |
| Booking latency (p95) | < 300 ms | < 300 ms | Strongly consistent; money is involved |
| Recommendation latency (p95) | < 500 ms | < 200 ms | Cache-first; precompute affinity |
| Evidence throughput | ~10s/sec | 10k+/sec | Stream-first from day one |
| Availability | 99.9% (booking/pay path) | 99.95% | BI can be lower |
| Consent/privacy | Airtight from day one | + data residency | Load-bearing for venue trust (see §6) |
| Take-rate metering | Accurate per booking | Real-time billing | First revenue is A-List take-rate |

### 1.3 Constraints

- **Small team, 14-month roadmap** → favour managed services and one deployable over a microservice fleet.
- **Cloud-native, AWS-primary** [ASSUMPTION]; GCP equivalents noted where relevant.
- **No rip-and-replace for venues** → Atlas integrates *around* Stripe/POS/Klaviyo; it does not replace them.
- **Arm's-length tenancy** → A-List gets no privileged access; the tenant contract must be complete enough that A-List can be built entirely on it.

---

## 2. High-Level Design

### 2.1 Architecture (MVP)

```
                        CONSUMERS / AGENTS / VENUES
   A-List app        Venue-link web       Venue dashboard      Consumer & tenant agents
   (iOS/web)         (no-signup book)     (BI/Audience Studio)  (Claude/ChatGPT via MCP)
       │                   │                     │                       │
       └───────────────────┴──────────┬──────────┴───────────┬───────────┘
                                       │                      │
                              ┌────────▼────────┐    ┌────────▼─────────┐
                              │   API Gateway    │    │   MCP Gateway    │
                              │ (REST, per-tenant│    │ (two-sided tools,│
                              │  OAuth/API keys) │    │  scoped by consent)│
                              └────────┬────────┘    └────────┬─────────┘
                                       │                      │
              ┌────────────────────────▼──────────────────────▼────────────────────────┐
              │             ATLAS CORE  —  modular monolith (ECS Fargate)               │
              │   Primitive APIs, one public contract, internal bounded contexts:       │
              │                                                                         │
              │  GUEST            OPS                     MARKETING                      │
              │  • Identity       • Bookings/Inventory    • Audience Studio              │
              │  • Taste graph    • Split-pay (Stripe)    • Recommendations              │
              │  • Crew           • Floor/Tab (Square)    • Lifecycle/CRM (Klaviyo)      │
              │  • Entitlements   • Demand routing        • Reporting/BI                 │
              │                                                                         │
              │  CONSENT LEDGER (cross-cutting)   IDENTITY RESOLUTION   METERING/BILLING │
              └───┬─────────────┬──────────────┬──────────────┬───────────────┬─────────┘
                  │             │              │              │               │
          ┌───────▼──┐  ┌───────▼───┐  ┌───────▼────┐  ┌──────▼──────┐  ┌─────▼──────┐
          │  Aurora   │  │  Redis    │  │  Evidence  │  │ OpenSearch  │  │  S3 lake   │
          │ Postgres  │  │(ElastiC.) │  │  stream    │  │ (catalog,   │  │ (raw +     │
          │ OLTP +    │  │ hot cache │  │(Kinesis/   │  │  audience   │  │ Parquet/   │
          │ affinity  │  │ sessions  │  │ EventBridge)│  │  queries)   │  │ Iceberg)   │
          │ + pgvector│  │ rate-limit│  └─────┬──────┘  └─────────────┘  └─────┬──────┘
          └───────────┘  └───────────┘        │                                │
                                       ┌───────▼────────┐              ┌────────▼────────┐
                                       │ Evidence/graph │              │  OLAP: Redshift  │
                                       │  workers (SQS) │              │  Serverless /    │
                                       │ normalize→write│              │  Athena over lake│
                                       │ evidence→recompute            │  (venue BI)      │
                                       └────────────────┘              └─────────────────┘
                                                ▲
                        ┌───────────────────────┴───────────────────────┐
                        │        CONNECTOR WORKERS (SQS-driven)          │
                        │  Stripe · Spotify · Instagram · Klaviyo · Square│
                        │  OAuth + webhooks → normalize → evidence primitive
                        └───────────────────────────────────────────────┘
```

**GCP mapping:** ECS→Cloud Run/GKE, Aurora→Cloud SQL/AlloyDB, Kinesis→Pub/Sub, Redshift/Athena→BigQuery, OpenSearch→Vertex Search, S3→GCS, ElastiCache→Memorystore, EventBridge→Eventarc.

### 2.2 The three planes and why they're split

- **Transactional (Aurora Postgres).** Bookings, split-pay, entitlements, identity merges. These need ACID transactions, idempotency, and low latency. Money and inventory correctness live here.
- **Evidence (stream → S3 lake).** Affinity evidence is append-only, high-volume, and only *eventually* needs to affect recommendations. Modelling it as a stream from day one means "more inputs" = more producers/consumers, never a re-architecture. It also keeps the moat claim honest: **the graph has no ingestion pipeline of its own** — connectors write evidence through the primitive, full stop.
- **Intelligence (OLAP + serving).** Venue BI (benchmarks, demand trends, cohort/community analysis) is analytical and read-heavy — it belongs on a columnar warehouse fed from the lake, not on the OLTP database. Recommendations are served from precomputed affinity in Postgres/Redis.

### 2.3 Primary data flow — "Instagram ad → repeat visit" (the canonical loop)

```
1. REACH   Instagram campaign + promoter code → A-List signup   (attribution primitive)
2. TASTE   Spotify OAuth → connector worker → evidence(affinity) → taste graph recompute
3. BOOK    Taste-ranked tables tonight → booking + split-pay (Stripe) → entitlement wallet
4. SPEND   Square POS webhook → tab evidence → joins guest profile (identity resolution)
5. RETURN  Audience Studio segments the cohort → Klaviyo winback → next visit booked
```
Every step is a primitive call; every step emits evidence; the venue only ever sees *derived* intelligence, never raw connector data.

---

## 3. Deep Dive

### 3.1 Data model (core OLTP — abridged)

Everything carries `tenant_id`; Postgres **Row-Level Security** enforces isolation (pooled multi-tenancy for MVP).

```sql
-- Identity ---------------------------------------------------------------
tenant(id, name, kind[anchor|venue|alist], created_at)

guest(id, tenant_id, primary_phone_e164, email, display_name,
      provisional bool, wallet_pass_id, created_at)           -- one row per resolved guest

identity_link(id, tenant_id, guest_id, kind[phone|email|card_fingerprint|
      spotify_id|instagram_id|wallet], value_hash, verified bool, source, created_at)
      -- merge_identities collapses links onto a surviving guest_id (append-only audit in identity_merge_log)

-- Consent (load-bearing) -------------------------------------------------
consent_grant(id, tenant_id, guest_id, scope, basis[connector_oauth|
      checkout_terms|explicit], connector, granted_at, revoked_at)

-- Evidence (append-only; the ONLY write path into the graph) --------------
affinity_evidence(id, tenant_id, guest_id, subject_type[artist|genre|venue|
      event|crew|table], subject_ref, signal[follow|listen|book|attend|spend|
      mute|loyalty], weight, provenance[connector|booking|venue_link|pos|agent],
      consent_grant_id, observed_at, dedupe_key)               -- partitioned by (tenant_id, month)

-- Derived taste graph (recomputed from evidence) ------------------------
guest_affinity(tenant_id, guest_id, subject_type, subject_ref,
      score float, decayed_at, embedding vector(768))          -- pgvector for similarity
      -- mutes override; time-decay applied at recompute

crew(id, tenant_id, name, owner_guest_id)
crew_member(crew_id, guest_id, role)
crew_affinity(crew_id, subject_ref, blended_score)             -- W2 blend function output

-- Ops --------------------------------------------------------------------
venue(id, tenant_id, name, city, floor_map_ref)
inventory(id, tenant_id, venue_id, kind[table|ticket], capacity, min_spend, deposit)
booking(id, tenant_id, venue_id, guest_id, crew_id, inventory_id,
      status[held|confirmed|seated|closed|cancelled], date, party_size,
      attribution_ref, created_at)                             -- state machine, ACID
payment(id, tenant_id, booking_id, stripe_pi_id, amount, split_group_id, payer_guest_id,
      status, idempotency_key)
entitlement(id, tenant_id, guest_id, kind[perk|ticket|loyalty_credit], state, expires_at)

-- Entities / catalog (cold-start, no guest consent) ---------------------
entity(id, kind[artist|event|venue], name, external_refs jsonb, metadata jsonb)

-- Metering ---------------------------------------------------------------
usage_event(id, tenant_id, kind[booking|api_call|mcp_call], billable_amount, occurred_at)
```

**Design notes**
- `affinity_evidence` is the audit log *and* the recompute source. `dedupe_key` (e.g. `sha(connector,external_id,signal)`) makes connector re-delivery idempotent.
- Right-to-erasure = tombstone evidence + purge derived rows; the append-only log keeps a redacted record for provenance.
- Cross-tenant rollups read from the lake, never from another tenant's OLTP rows.

### 3.2 API design (the public tenant contract)

**REST/JSON** for primitives (versioned, `/v1/...`), per-tenant OAuth2 client-credentials + scoped API keys. **GraphQL** for the venue dashboard read layer (dashboards are naturally graph-shaped, over-fetch-averse). Internal calls stay in-process in the monolith (become gRPC/events when split).

```
# Guest
POST /v1/guests                          # create (provisional ok)
POST /v1/guests/{id}/merge               # merge_identities(surviving, absorbed[])
POST /v1/evidence                        # append affinity evidence (the only graph write)
GET  /v1/guests/{id}/affinity            # resolved taste (respects mutes/decay)

# Ops
GET  /v1/venues/{id}/availability?date=&party=   # crew-aware ranked inventory
POST /v1/bookings                        # hold → confirm (idempotency-key header)
POST /v1/bookings/{id}/split-pay         # create split group, per-share PIs
POST /v1/webhooks/stripe|square          # signed inbound, → evidence

# Marketing / BI
POST /v1/audiences:query                 # Audience Studio segment (returns count + est. revenue)
POST /v1/campaigns                       # push discovery notif via Klaviyo, never a blast
GET  /v1/reports/{metric}?venue=&range=  # benchmarks, demand trends, cohorts
```

**MCP tools** (subset of the above, two-sided):
`search_availability`, `book_table`, `check_entitlements`, `guest_context` (tenant-side, consent-gated), `recommend_night` (consumer-side). Same primitives, different auth scope.

### 3.3 Taste graph & recommendations

- **Ingest:** connector worker normalises a raw signal → `POST /v1/evidence` with provenance + `consent_grant_id`. Nothing else writes the graph.
- **Recompute:** stream consumer applies **time-decay** ("last month beats last year"), **mutes override all**, and **bookings weigh most**. MVP does *incremental* recompute on hot signals + a nightly full pass; growth moves full recompute to Spark/Flink over the lake.
- **Serve:** `guest_affinity` (with pgvector embeddings) → candidate generation via vector similarity + rule filters (budget, availability, city, date) → ranking. Cache per-guest and per-crew results in Redis.
- **Crew blend (W2, unsolved & load-bearing):** MVP fallback = explicit crew filters (size, budget, vibe tags) + weighted vector combine of members, muted-union applied. Learned blend (from crew-level bookings) is a later model. **This is the top design risk** — the whole flow depends on it, so the interface (`crew_affinity`) is fixed now and the implementation swapped later.
- **Cross-tenant:** aggregates computed in the lake with **k-anonymity thresholds** (minimum tenants and guests per cell). Guest-level affinity never crosses tenants; only anonymised patterns roll up.

### 3.4 Identity resolution

Deterministic first (cheap, explainable), probabilistic later:
1. **Provisional guest** created at venue-link booking (name + phone + payment — operationally required anyway, so the join key is free).
2. **Merge** on verified phone/email via `merge_identities`; **Stripe card fingerprint** corroborates; **Wallet-pass ID** is a durable device-linked identifier and pre-app update channel.
3. Every merge is append-only in `identity_merge_log` (reversible, auditable). Evidence written under a provisional uid carries `venue_link` provenance and **does not generalise** across the graph until merged with a connector-linked profile.

### 3.5 Caching, queues, errors

- **Cache:** Redis for hot guest profiles, recommendation/availability results (short TTL + event-driven invalidation on new evidence/booking), sessions, and rate limits.
- **Queues:** SQS per connector + DLQs; EventBridge/Kinesis for the evidence stream and domain events. Connector jobs are idempotent (dedupe_key) and retried with backoff.
- **Errors:** booking/pay path uses ACID transactions + Stripe idempotency keys; a held booking auto-expires if payment doesn't complete. Evidence writes are fire-and-forget with at-least-once delivery (dedupe makes duplicates harmless). Webhooks verify signatures and are replay-safe.

---

## 4. Scale & Reliability

### 4.1 Load estimation (order-of-magnitude)

- MVP: 50k consumers × a few sessions/week, 10 venues, thousands of bookings/month → tens of evidence events/sec peak. **Single Aurora writer + read replica, one Kinesis shard** comfortably covers this.
- Growth (multi-city, millions of consumers): evidence to 10k+/sec → add Kinesis shards + parallel consumers; move full graph recompute to Spark/Flink; BI to Redshift with materialized aggregates; consider read-heavy affinity in a dedicated vector store.

### 4.2 Scaling strategy

- **Horizontal** on the stateless monolith (ECS Fargate autoscale behind ALB).
- **Data:** Aurora read replicas for BI/dashboards; partition `affinity_evidence` by tenant+month; the S3 lake is effectively unbounded.
- **Split when forced, not before:** the primitive/bounded-context boundaries inside the monolith are the seams. Extract the highest-load context (likely Recommendations or Evidence ingest) into its own service first.

### 4.3 Failover, redundancy, monitoring

- Multi-AZ Aurora + automated failover; Redis with replica; SQS/S3/Kinesis are managed-durable.
- DLQs on every async path; idempotent consumers make replay safe.
- **Observability:** OpenTelemetry traces, structured logs, CloudWatch dashboards + alarms on booking-path latency/error-rate, evidence lag, connector failure rate, and DLQ depth. Per-tenant **usage metering** feeds take-rate billing and is itself a monitored data quality surface.
- **Isolation blast radius:** RLS on every query; a per-tenant rate limit prevents one tenant (including A-List) from starving others.

---

## 5. Trade-off Analysis (explicit)

| Decision | Chosen (MVP) | Alternative | Why / cost |
|---|---|---|---|
| Service topology | **Modular monolith**, primitive APIs, internal contexts | 23 microservices | Small team + 14-mo runway; keep "one contract" story; split at real load. Cost: discipline needed to keep boundaries clean. |
| Multi-tenancy | **Pooled + Postgres RLS** | Silo DB per tenant | Cheap, fast to ship; per-tenant graph is logical. Cost: RLS mistakes are cross-tenant leaks — must be tested hard. Silo big tenants later. |
| Taste graph store | **Postgres + pgvector** | Neptune / dedicated vector DB | Fewer moving parts; relational + vector covers MVP matching and traversal. Cost: revisit if similarity/traversal dominates. |
| Evidence transport | **Stream (Kinesis) from day one** | Batch ETL / direct writes | Scaling = more shards, not a rewrite; keeps "graph is exhaust, no bespoke pipeline" true. Cost: streaming ops overhead up front. |
| BI/analytics | **Redshift Serverless / Athena over S3 lake** | Run BI on OLTP replica | Separates analytical load from money path; columnar is right for benchmarks/cohorts. Cost: a second data surface + freshness lag (CDC). |
| Recommendations | **In-house heuristic + vectors** | Off-the-shelf reco service | Taste blend is the differentiator and the moat — must own it. Cost: build effort; crew-blend is unsolved (W2). |
| MCP surface | **Thin gateway over primitives, day one** | Defer agent support | "Two-sided MCP day one" is a competitive wedge vs Apaleo's supply-only MCP. Cost: extra auth/consent scoping now. |
| Cross-tenant data | **Anonymised aggregates, k-anonymity thresholds** | Richer cross-tenant guest signal | Consent story must be airtight (venue trust). Cost: less immediate cross-tenant value; correct long-term. |

---

## 6. Consent, Privacy & the Data Contract (why this is first-class)

Venue-owned guest intelligence built on **consumer-consented** connectors is the whole moat — and its biggest risk. Requirements baked into the architecture:

- **Consent ledger** (`consent_grant`) is a hard dependency of `affinity_evidence`; no evidence is written without a grant and a basis.
- **Provenance on every signal** — connector vs booking vs venue-link vs POS vs agent — so weighting and generalisation rules can be enforced (venue-link evidence stays single-venue until merged).
- **Derived-only to venues.** The venue sees intelligence (profile, taste, spend history, return likelihood), never raw connector data.
- **Cross-tenant = anonymised + thresholded.** Below minimum tenant/guest counts, a cell is suppressed.
- **Tenant owns its graph;** the W1 data contract is an inter-company agreement (A-List ↔ Atlas) that names exactly what flows, what never flows, the consent basis, and ownership.
- **Erasure & portability** are first-class: tombstone + purge, with an auditable trail.

This maps directly to the plan's Q6 and the W1 deliverable.

---

## 7. Roadmap alignment

| Atlas phase | Deck phase | Architecture milestone |
|---|---|---|
| Phase 00 (now → Jul 2026) | Journey spec | Fix primitive contract + `crew_affinity` interface (W1/W2). No code lock-in beyond schemas. |
| Phase 01 (Aug–Sep 2026) | Alpha on Atlas core | Modular monolith, Aurora + pgvector, single evidence stream, Stripe + Spotify + Square live, MCP gateway stub. Booking + taste + split-pay on primitives. |
| Phase 02 (Oct–Dec 2026) | Closed beta | Anchor venues live; Instagram + Klaviyo connectors; Audience Studio + first BI reports; cross-tenant rollups gated on thresholds. |
| Phase 03 (Q1 2027) | Launch | One city hardened; observability + metering complete; erasure/consent audited. |
| Phase 04 (Q2 2027) | Take-rate on | Real-time metering → booking-revenue billing; loyalty wallet live. |
| Phase 05 (H2 2027) | Second city | First context extracted from the monolith (likely Recommendations/Evidence); Spark recompute; evaluate silo for large tenants. |

---

## 8. What I'd revisit as it grows

1. **Split the monolith** at the first real load ceiling — extract Recommendations or Evidence ingest first (clearest boundary, highest independent load).
2. **Lakehouse upgrade** — Kinesis → Iceberg on S3 with Spark/Flink for full graph recompute; retire nightly Postgres passes.
3. **Dedicated vector/graph store** if similarity search or crew/venue-audience traversal outgrows pgvector.
4. **Per-tenant silo** for large operators, data-residency, or a tenant that demands isolation — the RLS/pooled model is a starting point, not the end state.
5. **Crew-blend model** — replace the heuristic blend with a learned model once enough crew-level bookings exist (W2 is explicitly parked here).
6. **Real-time BI** — as venues rely on live dashboards, move from CDC batch freshness toward streaming aggregates.

---

## 9. Open questions (for the checkpoint)

- **Q-A.** Confirm AWS as primary cloud (this doc assumes it). Any data-residency constraints for target cities?
- **Q-B.** Is the venue dashboard a first-party surface in Phase 02, or does BI ship as reports/exports first? (Affects GraphQL vs report-API priority.)
- **Q-C.** Crew-blend: ship the heuristic fallback for Alpha and learn later — confirmed? (§3.3 assumes yes.)
- **Q-D.** Metering granularity for take-rate — per completed booking only, or per API/MCP call too? (§3.1 `usage_event` supports both.)
- **Q-E.** Which POS at the first anchor — Square vs Lightspeed — to lock the fifth connector (plan Q2).
