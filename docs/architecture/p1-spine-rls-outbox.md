# P1 — Identity Spine, Row-Level Security, and the Durable Evidence Outbox

_Status: implemented (2026-07-22). Companion to `design-review.md` — this doc records how
three of its P1 design-integrity items were built. It grounds every claim in the actual
Prisma models (`GlobalGuest`, `VenueProjectionGrant`, `EvidenceOutbox`, and
`Guest.globalGuestId`); no fields are described that do not exist in `schema.prisma`._

These three items were chosen together because they close the gap between what the pitch and
system-design docs **claim** and what the platform **enforces**: cross-tenant intelligence
without cross-tenant leakage (the moat vs. isolation contradiction, review §3.1), a real
isolation backstop (the meta-finding, review §1), and a taste graph that does not silently
lose or double-count evidence (P0-9 durability).

---

## 1. Identity spine + per-venue consented projection

### The contradiction it resolves

The business case (`design-review.md` §0, "A-List Is the Engine") makes two promises that,
taken literally, cannot both be true under the tenant model:

- **Moat:** _"venues see rich guest intelligence"_ — a venue should benefit from what Atlas
  has learned about a guest across the whole network.
- **Isolation:** _"guest affinity never crosses tenants"_ — one tenant's guest rows, evidence,
  and derived affinity must never be readable by another.

With each venue modelled as its own `Tenant`, there was no defined object through which
A-List's cross-network graph could _legally_ reach a venue. The design review flagged this
(§3.1) as the same missing object as the identity-merge problem (§3.2): a **shared identity
spine** plus a **consented, per-venue scoped projection** — not a raw share, and not a
blunt aggregate.

### The spine: `GlobalGuest`

`GlobalGuest` is the cross-tenant identity of a real person, independent of any tenant. It
carries no profile or affinity of its own — it is a join point:

```
model GlobalGuest {
  id          String   @id
  guests      Guest[]                  // the per-tenant rows that resolve to this person
  projections VenueProjectionGrant[]   // who may read a projection of this person
}
```

Each per-tenant `Guest` row resolves to the spine through the nullable
`Guest.globalGuestId` foreign key (indexed via `@@index([globalGuestId])`). Resolution is
driven by the existing **verified** `IdentityLink` rows (`kind` ∈ phone / email /
card_fingerprint / spotify_id / instagram_id / wallet, `verified = true`): when two tenants'
guests share a verified identifier, they can be attached to the same `GlobalGuest`.

Crucially, attaching a `Guest` to a `GlobalGuest` is an **append-only overlay**. Setting
`globalGuestId` links a tenant-local row into the spine; it does not move, rewrite, or merge
the tenant's `Guest`, `AffinityEvidence`, or `GuestAffinity` rows. Each tenant keeps its own
rows intact and isolated. The spine is a resolution layer _on top of_ tenant data, never a
destructive collapse of it.

```
   Tenant A                        Tenant B
   ┌─────────────┐                 ┌─────────────┐
   │ Guest (A)   │                 │ Guest (B)   │
   │ globalGuestId ─────┐   ┌───────── globalGuestId │
   └─────────────┘      │   │        └─────────────┘
                        ▼   ▼
                    ┌───────────────┐
                    │  GlobalGuest  │   ← cross-tenant spine (join point only)
                    └───────┬───────┘
                            │
                 VenueProjectionGrant
                 (globalGuestId, granteeTenantId,
                  scope="affinity:summary", revokedAt?)
                            │
                            ▼
                 ┌────────────────────────┐
                 │ Projection service read │  ← Venue tenant C reads a CONSENTED,
                 │  (consent-gated summary) │     DERIVED, SCOPED summary — never
                 └────────────────────────┘     Tenant A/B raw rows or identifiers
```

### The gate: `VenueProjectionGrant`

A guest — acting through their spine identity — consents to a **specific** venue tenant
seeing a **scoped** projection of their cross-tenant affinity:

```
model VenueProjectionGrant {
  id              String    @id
  globalGuestId   String                       // whose data
  granteeTenantId String                       // which venue tenant may read it
  scope           String    @default("affinity:summary")  // what may be projected
  grantedAt       DateTime
  revokedAt       DateTime?                     // revocable, like ConsentGrant
  @@unique([globalGuestId, granteeTenantId, scope])
}
```

The grant is per `(globalGuestId, granteeTenantId, scope)`. It is directional (guest → one
named venue tenant), scope-bounded, and revocable via `revokedAt` — mirroring the semantics
of the tenant-local `ConsentGrant` ledger, but for the cross-tenant boundary specifically.

### The projection service: the only sanctioned cross-tenant read

The projection service is the **single** code path permitted to read across the tenant
boundary. Its contract:

1. **Consent-gated.** It resolves the venue's local `Guest` to a `GlobalGuest`, then requires
   a live `VenueProjectionGrant` for `(globalGuestId, granteeTenantId, scope)` with
   `revokedAt IS NULL`. No grant → no read. Revoked grant → no read.
2. **Derived, not raw.** It returns a computed **summary** (e.g. top affinities within the
   granted `scope`), derived from the spine's affinity — never `AffinityEvidence` rows, never
   `GuestAffinity` rows verbatim, never another tenant's `Guest`.
3. **Scoped.** The `scope` string (default `affinity:summary`) bounds what may leave the
   spine. A venue gets top affinities, not the underlying evidence, weights, provenance, or
   any other tenant's identifiers.

Because it is the one intentional cross-tenant reader, it runs **without** a bound tenant
context — which is exactly why the RLS design (below) is permissive-when-unset rather than
deny-by-default: the projection path is a sanctioned exception, gated by grant checks in
code rather than by row-level tenant scoping.

### How this also fixes "merge vs. append-only" (review §3.2)

The review's identity-merge concern was that _"collapse onto surviving `guest_id`"_ either
rewrites evidence (breaking the append-only / replay guarantee) or fakes reversibility. The
spine sidesteps the destructive collapse entirely: two tenants' guests that are the same
person are **linked** through a shared `GlobalGuest`, not merged into one row. Evidence and
derived affinity stay attached to their original tenant-scoped `Guest`. The existing
append-only `IdentityMergeLog` still records within-tenant merges; the spine handles the
cross-tenant case as an overlay. Nothing is destroyed, and the linkage can be reasoned about
(and unwound) as data, not as an irreversible rewrite.

---

## 2. Row-Level Security (the meta-finding, review §1)

### What the review found

All four reviewers converged (⚑) on the same gap: the schema header and system-design doc
claim _"Postgres RLS enforces isolation in prod,"_ but there were **zero**
`ENABLE ROW LEVEL SECURITY` / `CREATE POLICY` statements, and nothing set a per-request
tenant context. Isolation rested entirely on every query hand-writing `where: { tenantId }`,
with omissions already live (P0-2). The review also named the classic footgun: RLS over a
pooled connection leaks across tenants unless the tenant context is set with `SET LOCAL`
inside a per-request transaction.

### The design

**Enable + force on every `tenantId` table.** For each table carrying a `tenantId` column,
the migration runs `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY`. `FORCE`
matters because the application connects as the schema owner; without it, RLS would be
bypassed for the owning role and the policy would be inert in exactly the deployment we run.

**The `tenant_isolation` policy — permissive when unset, enforcing when bound.** A single
policy per table keys on a session GUC, `app.current_tenant`:

```
USING (
  current_setting('app.current_tenant', true) IS NULL
  OR tenantId = current_setting('app.current_tenant', true)
)
```

- When `app.current_tenant` is **unset** (`NULL`), the policy is **permissive** — every row
  is visible. This is deliberately the state for migrations, seeding, admin/maintenance
  jobs, and the sanctioned cross-tenant **projection service** path.
- When the app **binds** the GUC to a tenant id, the policy is **enforcing** — only that
  tenant's rows are visible, regardless of whether a hand-written `where: { tenantId }` was
  present.

**Why permissive-when-unset is the safe rollout.** A deny-by-default policy (no rows when the
GUC is unset) would instantly break every path that legitimately runs without a tenant
context — migrations, seed, background workers, and the projection service — turning an
isolation hardening into an availability outage. Permissive-when-unset means turning RLS on
is a **non-breaking** change: existing app-layer `where: { tenantId }` filtering keeps
working unchanged, and RLS only begins to _constrain_ once handlers opt in by binding the
GUC. Isolation strength ratchets up as routes are wrapped, with no big-bang cutover.

**`SET LOCAL` inside a per-request transaction — `runWithTenant`.** The GUC is bound with
`SET LOCAL app.current_tenant = <tenantId>` inside a transaction opened per request, via a
`runWithTenant(tenantId, fn)` helper. `SET LOCAL` scopes the setting to the current
transaction only, so when the connection returns to the pool the setting is gone — closing
the pooled-connection-plus-RLS leak the review called out. Every query inside that
transaction inherits the bound tenant.

**Single DB user + FORCE RLS.** Because the app uses one database role (the owner), the
policy must apply to that owner — hence `FORCE ROW LEVEL SECURITY`. There is no separate
low-privilege application role that RLS would otherwise target; `FORCE` is what makes the
policy real for the role we actually connect as.

**Injection guard on the tenant id.** The tenant id is validated (UUID shape) before it is
ever interpolated into the `SET LOCAL` statement, so a crafted tenant id cannot break out of
the setting and inject SQL. The GUC binding is the one place a request-derived value reaches
a session-level `SET`, so it is guarded explicitly.

### Rollout and posture

- **Rollout step:** wrap mutating/reading handlers in `runWithTenant` (or install a
  request interceptor that opens the per-request transaction and binds the GUC from the
  authenticated tenant). Each wrapped handler moves from app-layer-only to RLS-enforced.
- **Posture:** RLS is **defense-in-depth**, not a replacement for the existing app-layer
  `where: { tenantId }` filtering. The app-layer filter stays; RLS is the backstop that
  makes an omitted filter fail closed instead of leaking (directly addressing P0-2's class
  of bug). Belt and suspenders, by design.

---

## 3. Durable evidence outbox (P0-9)

### What it replaces

The review (P0-9) found the evidence write to be a **non-transactional dual write**: a
Postgres `AffinityEvidence` row plus an in-memory bus publish that was **at-most-once with
silent loss** (`Promise.all(...).catch(log)`, no retry, no DLQ; `pubsub` mode only logged).
A transient error would permanently diverge the append-only evidence log from the derived
taste graph — corrupting the core asset.

### The transactional-outbox pattern

The fix is the standard transactional outbox. The evidence row and an outbox row are written
in the **same database transaction**:

```
model EvidenceOutbox {
  id          String    @id
  tenantId    String
  topic       String    @default("evidence")
  payload     Json
  dedupeKey   String
  attempts    Int       @default(0)
  publishedAt DateTime?
  createdAt   DateTime
  @@index([publishedAt, createdAt])
}
```

Because the `AffinityEvidence` insert and the `EvidenceOutbox` insert commit together, the
outbox row exists **if and only if** the evidence row does. There is no window where one
lands without the other.

A separate **relay** then scans for unpublished rows (`publishedAt IS NULL`, ordered by the
`@@index([publishedAt, createdAt])`), delivers each to the bus / Pub/Sub, and stamps
`publishedAt` on success, incrementing `attempts` on failure so it retries. The relay is a
poll-and-forward loop over durable rows, so it **survives restart**: an undelivered row is
still there after a crash and gets picked up on the next pass. This converts the pipeline
from **at-most-once with silent loss** to **at-least-once**.

### Idempotency — the price of at-least-once

At-least-once means the same evidence can be delivered more than once, so downstream must be
idempotent. Two mechanisms carry this:

- **`dedupeKey`.** The outbox row carries the same `dedupeKey` that uniquely identifies the
  evidence (`AffinityEvidence` enforces `@@unique([tenantId, dedupeKey])`). A redelivered
  message is recognisable as a duplicate of already-processed evidence.
- **Idempotent recompute.** The affinity recompute is written so that reprocessing the same
  evidence (same `dedupeKey`) does not move the score again — the derived `GuestAffinity`
  converges to the same value whether the evidence is seen once or five times. This is the
  same property demanded by P0-6 ("publish-only-on-insert + idempotent recompute"): the
  outbox delivers at-least-once, and the recompute makes redelivery a no-op rather than an
  inflation.

Together: the outbox guarantees the evidence log and the graph cannot diverge (durability),
and idempotent recompute guarantees at-least-once redelivery cannot double-count (correctness).

---

## 4. What's verified vs. runtime-pending

**Verified now (static / build-time):**
- Schema compiles; the new models (`GlobalGuest`, `VenueProjectionGrant`, `EvidenceOutbox`,
  `Guest.globalGuestId`) and their indexes/uniques are present and consistent.
- Build and lint are green.
- Unit tests for the projection consent gate, the `runWithTenant` GUC binding + injection
  guard, and the outbox write/relay/idempotency logic pass against their test doubles.

**Runtime-pending (validated in CI / at deploy against real Postgres):**
- **Enforcing RLS:** that `FORCE ROW LEVEL SECURITY` + the `tenant_isolation` policy actually
  block cross-tenant reads once `app.current_tenant` is bound, and stay permissive when it is
  unset — this only proves out against a real Postgres with the policy applied, exercised by
  an integration test that binds one tenant and asserts another tenant's rows are invisible.
- **Relay against real Postgres / Pub/Sub:** that the relay drains `EvidenceOutbox` rows,
  delivers at-least-once, and resumes cleanly after a restart — validated against a real
  broker in the deploy pipeline, not against the in-memory double.
- The projection service returning a correctly scoped summary (and nothing more) over
  real cross-tenant data, gated by a live `VenueProjectionGrant`.

These three land as CI integration checks / deploy-gate assertions so the enforcing behaviour
is proven in the environment that actually runs it.
