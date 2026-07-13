# Atlas

Atlas is the multi-tenant **intelligence-and-booking platform** for hospitality — the substrate that turns everyday guest and venue actions into venue-facing intelligence. It exposes ~23 **primitives** (versioned public APIs) across three hubs — **Guest**, **Ops**, **Marketing** — and every tenant consumes the same public contract.

**A-List** is Atlas's first tenant and first customer: the consumer app for discovering, planning, and booking nightlife. A-List is the *engine* that generates the taste and behavioural data Atlas learns from.

## Documentation

- [`docs/architecture/atlas-system-design.md`](docs/architecture/atlas-system-design.md) — system design (draft v1): requirements, high-level architecture, data model, API contract, taste graph, identity resolution, scale/reliability, trade-offs, and the consent/data-contract model.
- [`docs/architecture/data-contract-alist-atlas.md`](docs/architecture/data-contract-alist-atlas.md) — W1 A-List ↔ Atlas data contract: what lives where, the four ingest classes, what flows / never flows, consent basis, ownership, and identity-join mechanics.
- [`docs/architecture/primitive-api-spec.md`](docs/architecture/primitive-api-spec.md) — the primitive-by-primitive public tenant API contract (23 primitives across Guest/Ops/Marketing), with scopes, evidence emitted, MCP exposure, and MVP staging.
- [`docs/architecture/alist-journey-w2.md`](docs/architecture/alist-journey-w2.md) — W2 screen-level A-List journey mapped onto the primitives (onboarding → PLAN → ADJUST → BOOK & PAY → LIVE → WRAP), including the crew taste-composition (blend) interface and the venue-link (class 1b) variant.
- [`docs/architecture/integrations-decision-w3.md`](docs/architecture/integrations-decision-w3.md) — W3 first-five integrations decision (Stripe, Spotify, Instagram, Klaviyo, Square confirmed), with consent/evidence posture and the Phase 01/02 build sequence.
- [`docs/architecture/integration-loops-w4.md`](docs/architecture/integration-loops-w4.md) — W4 three end-to-end integration loop stories (Instagram-ad→repeat-visit, venue-link→app-conversion→merge, artist-announce→winback) over the first five integrations (Stripe, Spotify, Instagram, Klaviyo, Square).
- [`docs/architecture/competitor-positioning-w5.md`](docs/architecture/competitor-positioning-w5.md) — W5 positioning-led "where we win" grid vs Fourvenues / Tablelist / SevenRooms / Tock-Resy (Apaleo for agent-readiness), plus the internal feature appendix.
- [`docs/architecture/primitive-additions-triage-w6.md`](docs/architecture/primitive-additions-triage-w6.md) — W6 triage of candidate hub additions into capability / new-primitive / integration / later, keeping the "23 primitives, one contract" count stable.
- [`docs/architecture/first-paid-wedge-w7.md`](docs/architecture/first-paid-wedge-w7.md) — W7 first-paid-wedge one-pager: booking take-rate first, then venue SaaS as "guest intelligence"; what we sell, to whom, and what we never lead with.

## The platform (code)

A NestJS + Prisma **modular monolith** implementing the primitive contract. Each primitive is a Nest module under `src/modules/{guest,ops,marketing}`; the taste graph is fed exclusively through the append-only evidence path (`POST /v1/evidence` → `EvidenceBus` → recompute worker). External vendors (Stripe, Spotify, Instagram, Klaviyo, Square) are behind adapters in `src/integrations/` that run in **stub mode** when their credentials are unset, so the whole platform boots and the booking/taste loops are exercisable with no cloud or vendor keys.

```
src/
  common/         # prisma, tenancy (RLS-ready), scopes auth guard, idempotency, evidence bus
  integrations/   # Stripe / Spotify / Instagram / Klaviyo / Square adapters (stubbed)
  modules/
    guest/        # Identity, Consent, Connectors, Taste/Evidence, Crew(+blend), Entitlements, Loyalty, Trust
    ops/          # Bookings, Inventory, Deposits, Payments, Tab, Routing, Door, Closeout
    marketing/    # Audiences, Discovery, Lifecycle, Attribution, Winback, Reporting, Entities
    mcp/          # two-sided MCP tool manifest
prisma/schema.prisma   # the full data model (system-design §3.1)
deploy/gcp/            # Cloud Run + Terraform (Cloud SQL, Memorystore, Pub/Sub, BigQuery, GCS)
```

### Run locally

```bash
cp .env.example .env
docker compose up -d postgres redis      # Postgres + Redis
npm install
npx prisma generate
npx prisma db push                        # create the schema
npm run prisma:seed                       # optional: A-List + anchor venue + a guest
npm run start:dev                         # http://localhost:3000  (Swagger at /docs)
```

Dev auth is header-based (`DEV_TRUST_HEADERS=true`): pass `X-Tenant-Id` and space-separated `X-Scopes` (use `*` for all). Example — append taste evidence:

```bash
curl -sX POST localhost:3000/v1/evidence \
  -H 'X-Tenant-Id: <tenantId>' -H 'X-Scopes: *' -H 'Content-Type: application/json' \
  -d '{"guestId":"<id>","subjectType":"artist","subjectRef":"Keinemusik","signal":"follow","provenance":"connector","dedupeKey":"demo-1"}'
```

### Deploy target (GCP)

Cloud Run for the monolith; Cloud SQL (Postgres) transactional plane; Pub/Sub + GCS the evidence plane; BigQuery the intelligence plane; Memorystore for serving. See `deploy/gcp/` (`EVIDENCE_BUS=pubsub` switches the bus off the in-memory dev implementation).

## Status

Phase 01 (Alpha) — the modular monolith and MVP primitives are being built on the contract. See the roadmap section of the system design doc.
