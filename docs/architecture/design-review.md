# Atlas — Design & Architecture Review

_Status: review (2026-07-14). Method: four independent reviews run in parallel over
(1) the architecture/design docs, (2) the Prisma data model, (3) the application code &
security, and (4) deploy/infrastructure. Findings that were flagged **independently by
more than one reviewer** are marked ⚑ — that convergence is the strongest signal they are
real._

This review grades the **implementation against its own claims**. The conceptual design is
strong: evidence-as-exhaust with a single write path, a disciplined primitive contract,
consent-as-a-hard-dependency, and a named exit ramp for every "start simple" choice. The
gaps below are where a doc/comment asserts a property the code does not yet provide.

---

## 0. Strategic framing — why these findings matter to the pitch

Per _"A-List Is the Engine"_, the business is a flywheel: **A-List (consumer app) generates
behavioural data → Atlas learns → Atlas hands intelligence back to venues → better
experiences → more guests → more bookings.** Venues are the _distribution partner_, not the
first customer, and the rule is _"the consumer gets value before the venue does."_

That framing makes three clusters of findings **business-critical, not hygiene**:

| Pitch claim | Depends on | At-risk findings |
|---|---|---|
| "Atlas gets smarter every booking" | Taste-graph integrity | Affinity double-counts on redelivery (P0-6); per-event (not per-time) decay (P1-4); incremental-vs-nightly recompute drift (P1-3) |
| "We package guest context back to venues" | A consented cross-tenant projection | Moat-vs-isolation contradiction (P1-1); identity-merge model (P1-2) |
| "Consumer value first" — cross-venue loyalty, crews, shared payments | Identity resolution + money path | False-merge risk (P1); split-pay saga (P1-6); money correctness (P0-7) |

If the graph is not trustworthy, the flywheel's central promise is false. These are ranked
accordingly.

---

## 1. The meta-finding ⚑ (all four reviewers)

> ✅ Implemented (see [p1-spine-rls-outbox.md](p1-spine-rls-outbox.md)) — RLS now exists:
> `ENABLE`+`FORCE ROW LEVEL SECURITY` on every `tenantId` table, a `tenant_isolation` policy
> (permissive when `app.current_tenant` is unset, enforcing when bound), and `runWithTenant`
> setting the GUC via `SET LOCAL` in a per-request transaction. Defense-in-depth behind the
> existing app-layer `tenantId` filtering.

**Tenant isolation is app-level only. The promised Postgres RLS does not exist.**
The schema header and system-design doc state _"Postgres RLS enforces isolation in prod,"_
but there are **zero** `ENABLE ROW LEVEL SECURITY` / `CREATE POLICY` statements in the
migration, and `PrismaService` sets no per-request tenant context. Isolation rests entirely
on every developer hand-writing `where: { tenantId }` forever — with **no backstop, and
omissions already exist** (see P0-2). Additionally, when RLS _is_ added, the pooled-connection
+ RLS combination is a well-known cross-tenant leak footgun unless tenant context is set with
`SET LOCAL` inside a per-request transaction.

**Fix:** add RLS keyed on a `SET LOCAL app.tenant_id` session var per request/transaction,
**and/or** a Prisma client extension that injects + asserts `tenantId` on every tenant-scoped
model. Until then, delete the claim so it doesn't read as a shipped control.

---

## 2. P0 — Ship-blocking (correctness, money, or cross-tenant data)

| # | Finding | Where | Src |
|---|---------|-------|-----|
| P0-1 | **No production auth path.** `DEV_TRUST_HEADERS` defaults **ON**; `TenantMiddleware` blindly trusts client `X-Tenant-Id` + `X-Scopes`. Any caller can impersonate any tenant with any scope. The promised OAuth2 verification is unimplemented, so setting it `false` 401s the entire API — **there is no correct prod config today.** | `configuration.ts:31`, `tenant.middleware.ts:17-33` | code |
| P0-2 | **Cross-tenant IDOR — live, not hypothetical.** ⚑ `CrewMember`/`CrewAffinity` have **no `tenantId`**; `availability.service` + `crew-blend.service` query by user-supplied `crewId` with no tenant check. A guessed/leaked `crewId` returns another tenant's crew taste & membership. | `schema.prisma:209-231`, `availability.service.ts:44`, `crew-blend.service.ts:23` | data, code |
| P0-3 | **Webhooks are forgeable.** `verifyWebhook` is a stub returning `true` in dev; raw body isn't captured so real HMAC can't work in prod either. Anyone can `POST /webhooks/stripe` to mark a payment `succeeded` (unscoped `updateMany` by `stripePiId`) or inject `spend` evidence via Square, poisoning the graph and revenue. | `stripe.adapter.ts:41`, `square.adapter.ts:24`, `payments.module.ts:95` | code |
| P0-4 | **Duplicate bookings → double billing.** ⚑ Idempotency is presented as done, but the interceptor is **dead code** (never wired, in-memory, race-unsafe) and no unique key exists. A retried `POST /bookings` creates duplicate bookings **and** duplicate `UsageEvent` (metering) rows. Hold→confirm is two non-transactional writes. | `bookings.module.ts:55-96`, `idempotency.interceptor.ts` | data, code |
| P0-5 | **Overbooking.** Nothing prevents two confirmed bookings on the same `inventoryId`/`date` — no capacity check, no hold row, no `SELECT … FOR UPDATE`. | `bookings.module.ts:55`, `availability.service.ts:32` | data |
| P0-6 | **Affinity double-counts on redelivery.** ⚑ `appendEvidence` publishes to the bus **unconditionally**, even on a duplicate no-op insert; recompute (`prior*0.9 + contribution`) is non-idempotent and races. At-least-once redelivery silently inflates the taste graph — the core asset. | `taste.service.ts:35-69`, `affinity-recompute.service.ts:60` | data, code |
| P0-7 | **Money stored as `Float`.** `Payment.amount`, `Tab.total`, `Inventory.minSpend/deposit`, `UsageEvent.billableAmount` are binary floats flowing through split-pay sums and take-rate math → cent drift; won't reconcile against Stripe/Square integer minor units. | `schema.prisma:297,344,360,427` | data |
| P0-8 | **Consent revocation is a no-op on derived data.** ⚑ `revoke` only sets `revokedAt`; evidence and the `GuestAffinity` derived from withdrawn-consent data remain and are still served. Compliance + correctness failure on the exact dimension that is the moat. | `consent.module.ts:35` | data, arch |
| P0-9 | **Evidence write is a non-transactional dual write** (Postgres row + in-memory bus), and the bus is **at-most-once with silent loss** (`Promise.all(...catch(log))`, no retry/DLQ); `pubsub` mode only logs — the prod transport doesn't exist. A transient error permanently diverges the log from the graph. | `evidence-bus.ts:47-60`, `taste.service.ts` | arch, code |

> ✅ P0-9 Implemented (see [p1-spine-rls-outbox.md](p1-spine-rls-outbox.md)) — transactional
> outbox: the `AffinityEvidence` row and an `EvidenceOutbox` row commit in one transaction; a
> restart-surviving relay delivers to the bus/Pub/Sub at-least-once. Idempotency via `dedupeKey`
> + idempotent recompute. Replaces the fire-and-forget at-most-once in-memory publish.

### P0 — Infra (production-safety; low-effort, high-payoff)
- **Cloud SQL** has `deletion_protection = false`, no PITR, `ZONAL`, and a public IP — the
  system of record is one stray delete or zonal outage from gone. _(deletion-protection +
  PITR + backup retention applied in this change; private IP + REGIONAL HA staged.)_
- **WIF trust is repo-wide** — _any_ branch/workflow can impersonate a deploy SA holding
  project `run.admin`. Scope to `refs/heads/main` + a GitHub Environment gate.
- **IAM over-broad** — runtime SA has project-wide `secretAccessor` (reads _every_ secret);
  deployer has project-wide `serviceAccountUser`. Scope to the two secrets / the one SA.
- **No Cloud Run probes**, and the in-process recompute worker is CPU-throttled between
  requests → the evidence pipeline silently lags. Wire `/health` probes; move the worker to a
  Pub/Sub push subscription or Cloud Run Job.
- **Deploy isn't gated on CI** — a push that fails tests still deploys if `docker build`
  passes; no concurrency guard on migrate+replace. _(gate + concurrency applied in this change.)_

---

## 3. P1 — Design integrity (make the elegant claim true before scale)

1. **The moat contradicts the isolation guarantee.** ⚑ "Venues see rich guest intelligence"
   (pitch steps 4–5) vs "guest affinity never crosses tenants." With each venue a separate
   tenant, the docs never define how A-List's graph legally reaches a venue. **This and
   identity-merge are the same missing object: a shared identity spine (`guest_global_id`) +
   a consented, per-venue _scoped projection_** (not an aggregate). Resolve these two first —
   the recompute/serving/erasure clusters all depend on the resulting model.
   ✅ Implemented (see [p1-spine-rls-outbox.md](p1-spine-rls-outbox.md)) — `GlobalGuest` spine +
   `Guest.globalGuestId` linkage + `VenueProjectionGrant` + a consent-gated projection service
   (the only sanctioned cross-tenant read: a derived, scoped summary, never raw rows). This also
   resolves the merge-vs-append-only concern below (spine linkage is an append-only overlay).
2. **Merge vs append-only.** "Collapse onto surviving `guest_id`" either rewrites evidence
   (breaks append-only/replay) or needs an unspecified resolution overlay. Make merge an
   **append-only overlay** via `identity_merge_log`, resolved at read/recompute time. (Today's
   merge also destroys derived data and fakes reversibility with a display-name hack.)
3. **Lambda-recompute drift.** Incremental + nightly full pass compute affinity two ways with
   no reconciliation. Make the **nightly pass authoritative + idempotent** (deterministic
   replay from the log); treat incremental as a cache; add a drift metric.
4. **Decay is per-event, not per-time** — order-dependent and non-reproducible. Make decay a
   function of `now − observedAt`.
5. **Shared DB silently couples the "bounded contexts."** The "scale ≠ re-architecture"
   promise only holds if the seams are real. Enforce per-context table ownership + a
   module-boundary lint now; pre-draw the Evidence-ingest and Recommendations seams.
6. **Split-pay has no partial-failure saga** (5 of 6 shares captured, 6th lapses at hold
   expiry → undefined). Authorize-not-capture, atomic capture at confirm, compensation on
   timeout.
7. **Isolation in the non-Postgres stores** (Redis, OpenSearch, Redshift, S3) is asserted as
   if RLS covers them — it doesn't. State + test per-store isolation; this also multiplies the
   erasure surface.
8. **Erasure fan-out across 5+ stores is undefined** — needs an orchestration primitive with
   per-store completion tracking and an SLA. Define "redacted" concretely.
9. **pgvector ANN runs on the OLTP money-path primary** — serve affinity/vector reads from a
   read replica so recommendations can't degrade the <300ms booking SLA.

### P1 — Security & data hygiene
- **OAuth connector flow** has a predictable `state`, no CSRF check, and accepts a
  **client-supplied access token** instead of a server-side code exchange → forgeable consent
  grants (`connectors.module.ts:47-87`).
- **No pagination** on list/aggregate endpoints — `repeat_rate`/`cohort`/`audiences` load
  whole tables into JS memory (DoS + latency); `listEvidence` is hard-capped at 25 with no
  cursor, so the audit log isn't fully queryable.
- **Validate ownership** of body-supplied `guestId`/`payerGuestId` before writes.
- **MCP delegated-authority model** (how an agent proves it may spend on a guest's behalf;
  `guest_context` as a prompt-injection exfil target) is hand-waved — and the "day one" MCP
  wedge is a stub per the roadmap.
- Add `tenantId` **FKs** on the ~14 tenant-scoped tables that lack them; make
  `stripePiId`/`idempotencyKey` unique + indexed; promote status/kind free-strings to enums;
  partition + set retention on the append-only `AffinityEvidence`/`UsageEvent` tables.
- **False-merge risk:** deterministic merge on a single verified phone/email blends two
  people's graphs (recycled numbers, shared family email/card). Require multi-factor
  corroboration for auto-merge; hold single-signal matches as suggested; define unmerge
  triggers.

---

## 4. P2 — Hardening
Redis AUTH + TLS · Terraform state versioning (it holds the DB password in plaintext) ·
monitoring/alerting/tracing (none exists — nobody is paged) · Pub/Sub DLQ + max backoff ·
Prisma connection-pool sizing vs Cloud SQL `max_connections` · non-root container + image
scanning · un-mute path (mute is permanently sticky and score keeps growing) · bounded
evidence `weight` + `forbidNonWhitelisted` · k-anonymity is weak to differencing attacks over
time (constrain the query surface, not just cells) · `updatedAt` + real soft-delete for GDPR.

---

## 5. What's genuinely good (keep)
- Fail-closed `ScopesGuard`; every mutating route carries `@Scopes` (verified).
- Keyless CI via Workload Identity Federation — no long-lived keys in GitHub.
- Migrate-before-deploy as an isolated Cloud Run Job; secrets via `secretKeyRef`, not baked in.
- VPC connector with private-ranges egress; log redaction of auth/scope headers.
- Evidence + identity-link **idempotency keys are correctly tenant-scoped**;
  `GuestAffinity` derived-row key is right; `IdentityService.merge` is transactional.
- Naming crew-blend as the top risk and hedging it behind a swappable interface.

---

## 6. Recommended remediation sequence
1. **Do-now (Small, non-breaking):** Cloud SQL deletion-protection + PITR ✅, gate deploy on
   CI + concurrency ✅, branch-scope WIF, least-privilege IAM.
2. **P0 correctness sprint (needs care — touches live deploy + DB migrations):** production
   auth (P0-1), webhook HMAC + raw body (P0-3), idempotency keys + transactional hold→confirm
   (P0-4), inventory locking (P0-5), `Float`→minor-units money (P0-7),
   publish-only-on-insert + idempotent recompute (P0-6), consent-revoke → recompute (P0-8),
   transactional outbox for the evidence write (P0-9).
3. **P1 design:** the identity-spine + per-venue consented projection (unblocks the
   moat/merge/recompute cluster), then RLS as defense-in-depth.

_Applied in this change:_ Cloud SQL deletion protection + point-in-time recovery + backup
retention; deploy workflow gated on a passing test job with a concurrency guard. Everything
else above is staged.
