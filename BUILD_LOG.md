# ATLAS Build Log — Platform (NestJS monolith)

Live log of the ATLAS platform build. Mirrored to Confluence (space "Adrian D" →
*ATLAS Build Log — Platform*). Branch: `claude/system-design-wt0pcw`.

**Status: DEPLOYED & LIVE-VERIFIED** — the modular monolith is deployed on GCP
Cloud Run and the full taste + booking loop was verified against the live URL.

- **Live URL:** https://atlas-4je5vwjoha-uc.a.run.app (`/health` → `{"status":"ok","db":"up"}`, Swagger at `/docs`)
- **Project:** `atlas-502319` — Cloud Run + Cloud SQL (Postgres) + Memorystore (Redis) + Pub/Sub + BigQuery + GCS lake
- **State/CD:** GCS-backed Terraform state; keyless auto-deploy (GitHub WIF) on merge to `main`; PR #2 merged.

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
| CI | GitHub Actions build + lint + test against Postgres — passing on PR #2 | ✅ Done |
| GCP deploy pipeline | Terraform (SQL, Redis, Pub/Sub, BigQuery, GCS, Artifact Registry, Secret Manager, VPC connector, GitHub WIF), Prisma migrations, deploy.sh, keyless CD workflow — project `atlas-502319` | ✅ Done |
| Build verification | nest build, eslint, jest, live boot + end-to-end loop, migration apply + prod boot | ✅ Done |
| **Live GCP deployment** | Cloud Build image → Cloud SQL migrations (Cloud Run Job) → Cloud Run service; full loop verified against the live URL | ✅ Done |

## Architecture notes
- **Three planes:** transactional (Postgres OLTP), evidence (append-only affinity log → EvidenceBus → recompute worker; Pub/Sub in prod), intelligence (recommendations + BI).
- **Evidence-as-exhaust:** the taste graph has exactly one write path — `POST /v1/evidence`. Connectors normalise to evidence; nothing writes the graph directly.
- **Pooled multi-tenancy:** every query scoped by `tenantId` (RLS-ready); scopes enforced by a global guard using `hub:primitive:action` naming.
- **Crew blend (W2):** fixed `blend(crewId) → crew_affinity` interface with hard invariants (mute-union, time-decay, bookings weigh most, explainable); MVP heuristic now, learned model later.

## End-to-end verification (live, against the Cloud Run deployment)

Driven against `https://atlas-4je5vwjoha-uc.a.run.app`:

| Step | Live result |
|---|---|
| Health | `{"status":"ok","db":"up"}` |
| Spotify connect → consent + 4 taste evidence | `synced: 4` |
| Recompute worker → resolved affinity | afro house 4.5, Keinemusik 3, Black Coffee 2.5 |
| Mute overrides all | muted `melodic house` → removed |
| Crew blend consensus boost | afro house `blendedScore 9, confidence 1` |
| Availability (crew-aware) | Booth 1 (capacity-matched) |
| Book (held→confirmed, idempotency) | bookingId returned |
| Deposit (Stripe) | `pi_stub_deposit_…` held |
| Split-pay (per-share PaymentIntents) | splitGroupId + 2 PIs |
| Square tab → spend evidence | `{received: true, lineItems: 1}` |
| Recommendations ranked by affinity | afro house → Keinemusik → … |
| Audience Studio | `{count: 1, estimatedRevenue: 150}` |
| Scope guard (missing scope) | **403** |

## Deploy hardening (blockers cleared during the live deploy)
- Cloud Shell ships a fake `terraform` stub → install and invoke the real binary.
- HCL syntax (single-line `replication { auto {} }`) → multi-line.
- First-time API enablement race → pre-enable all APIs via `gcloud services enable`.
- Wiped local state across re-clones → **GCS remote backend** + `terraform import` adoption of pre-existing resources.
- Cloud SQL created with all IP connectivity disabled (Error 400) → enable public IP (reached via the managed Cloud SQL socket).

See `README.md`, `deploy/gcp/README.md`, and `docs/architecture/` for source, run/deploy instructions, and the API contract.
