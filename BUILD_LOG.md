# ATLAS Build Log — Platform (NestJS monolith)

Live log of the ATLAS platform build. Mirrored to Confluence (space "Adrian D" →
*ATLAS Build Log — Platform*). Branch: `claude/system-design-wt0pcw`.

**Status: BUILD GREEN** — the modular monolith compiles, lints, tests pass, and
boots against Postgres with the full taste + booking loop verified end-to-end.

## Stack decisions
- **TypeScript / NestJS** modular monolith on the primitive contract.
- **All MVP primitives** across Guest / Ops / Marketing.
- Deploy target **GCP** (Cloud Run + Cloud SQL + Pub/Sub + Memorystore + BigQuery); docker-compose for local dev.
- External vendors run in **stub mode** when credentials are unset — boots with no cloud/vendor keys.

## Coding jobs

| Job | Scope | Status |
|---|---|---|
| Foundation | Scaffold, Prisma schema (full data model), config, PrismaService, tenant context + RLS-ready middleware, scopes auth guard, idempotency, evidence bus (in-memory + Pub/Sub) | ✅ Done |
| Guest hub (8 primitives) | Identity (+merge), Consent ledger, Taste connectors, Taste/Evidence (+recompute worker), Crew (+blend), Entitlements, Loyalty, Trust | ✅ Done |
| Ops hub (8 primitives) | Bookings, Inventory/Floor, Deposits, Split-pay/Payments (Stripe), Tab/POS (Square), Demand routing, Door/Check-in, Closeout | ✅ Done |
| Marketing hub (7 primitives) | Audience Studio, Discovery/Recommendations, Lifecycle/CRM (Klaviyo), Attribution, Winback, Reporting/BI, Entities catalog | ✅ Done |
| MCP gateway | Two-sided tool manifest (consumer + tenant tools) | ✅ Done |
| Integrations | Stripe, Spotify, Instagram, Klaviyo, Square adapters (stub mode) | ✅ Done |
| Deploy + CI | docker-compose, Dockerfile, GCP Cloud Run + Terraform, GitHub Actions CI | ✅ Done |
| Build verification | nest build, eslint, jest, live boot + end-to-end loop | ✅ Done |

## Architecture notes
- **Three planes:** transactional (Postgres OLTP), evidence (append-only affinity log → EvidenceBus → recompute worker; Pub/Sub in prod), intelligence (recommendations + BI).
- **Evidence-as-exhaust:** the taste graph has exactly one write path — `POST /v1/evidence`. Connectors normalise to evidence; nothing writes the graph directly.
- **Pooled multi-tenancy:** every query scoped by `tenantId` (RLS-ready); scopes enforced by a global guard using `hub:primitive:action` naming.
- **Crew blend (W2):** fixed `blend(crewId) → crew_affinity` interface with hard invariants (mute-union, time-decay, bookings weigh most, explainable); MVP heuristic now, learned model later.

## End-to-end verification (live boot against Postgres)

| Step | Result |
|---|---|
| Health | `{status: ok, db: up}` |
| Spotify connect → consent + 4 taste evidence | Pass |
| Recompute worker → resolved affinity (afro house 4.5) | Pass |
| Mute overrides all (removes muted genre) | Pass |
| Crew blend consensus boost (blendedScore 9, confidence 1) | Pass |
| Book (held→confirmed, idempotency) → deposit → split-pay → Square tab spend | Pass |
| Recommendations ranked by affinity | Pass |
| Audience Studio: count + estimated revenue (same-tenant 1 / cross-tenant 0 — isolation) | Pass |
| Scope guard returns 403 when scope missing | Pass |

See `README.md` and `docs/architecture/` for source, run instructions, and the API contract.
