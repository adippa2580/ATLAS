# W1 — A-List ↔ Atlas Data Contract

**Status:** Draft v1 (for the Jul-20 checkpoint with Jack)
**Date:** 2026-07-13
**Owner:** Adrian
**Maps to:** Project Plan §3, §3.1, Q6; deck slide 10 (A-List × Atlas).
**Purpose:** the one-page inter-company agreement — *what lives where, what flows, what never flows, on what consent basis, and who owns it.* Because A-List and Atlas are separate companies, this is a real contract, not an internal note; that separation is what forces the consent questions to be answered properly.

---

## 1. What lives where

| | **A-List** (separate company / brand) | **Atlas** (platform company) |
|---|---|---|
| Owns | Brand, consumer UX, connector onboarding UX, crew UI, discovery surfaces, split-pay UX, the company itself | All 23 primitives — identity, taste graph, bookings, entitlements, comms, floor/demand ops, reporting |
| Keeps **no** | Private backend logic. If A-List needs a capability it becomes (or extends) a primitive **any** tenant can use | Consumer brand or private per-tenant hooks |
| Relationship | Atlas's **first tenant and first customer**, at arm's length, through the public tenant contract | The substrate A-List (and every venue) runs on |

**The rule (deck slide 10):** *what A-List needs becomes a primitive any tenant can use.* No privileged private API. If A-List can't be built on the public contract, the contract is incomplete — that's the design signal, not a reason to add a back door.

---

## 2. The four ingest classes (+ 1b)

A-List is the **first and richest** ingest point, not the only one. The graph keeps **no ingestion pipeline of its own** — "more inputs" means more tenants and more connectors writing **evidence through primitives**, never bespoke pipelines. That is what keeps the zero-marginal-collection-cost moat true.

| Class | Source | What only it provides | Arrives via | Consent basis |
|---|---|---|---|---|
| **1. Consumer surface** | A-List app | Pre-transaction signal: identity-linked taste (Spotify/Instagram), crew composition, intent, browsing | Guest-side primitives | Connector OAuth + app ToS |
| **1b. Venue-link web bookings** | Venue IG/bio → A-List web | High-intent, venue-attributed demand from guests with **no** A-List account: booking + spend before any taste connector | Guest-side primitives, **provisional guest uid** | Checkout terms (observed behaviour) |
| **2. Venue-side exhaust** | Anchor + venue tenants | Ground truth: POS spend, attendance, no-shows, tab size, repeat visits — independent of how the guest arrived | Ops primitives + connectors (Stripe, Square, Klaviyo) | Tenant data-processing agreement |
| **3. Entity catalog** | Public / partner feeds | Cold-start: events, artists, lineups, venue metadata — **no guest consent involved** | Entities primitive | N/A (non-personal) |
| **4. Agent traffic** *(later)* | Claude / ChatGPT via MCP | Demand from guests who never open A-List | Inbound MCP surface | Per-request consent scope |

**Constraint:** purchased/scraped data is allowed at the **entity/catalog layer only**. Guest-level affinity comes **exclusively** from consented connectors and observed behaviour — or the consent story fails.

---

## 3. What flows A-List → Atlas

Everything crosses as **affinity evidence**: an append-only, provenance- and consent-tagged record written through the `evidence` primitive (never a direct graph write). See `atlas-system-design.md` §3.1 `affinity_evidence`.

| Signal | Example | Weight posture | Provenance tag |
|---|---|---|---|
| Taste connector | Spotify artists/genres, Instagram scenes | High for depth/obsession; time-decayed | `connector` |
| Crew composition | Who booked with whom | Feeds crew blend; attached to real bookings | `booking` / `crew` |
| Intent / browsing | Saved events, follows, searches | Low-to-medium; noisy | `connector` (app) |
| Booking | Table/ticket held & confirmed | **Weighs most** (paid action) | `booking` |
| Spend | POS tab joined post-visit | Ground-truth revealed preference | `pos` |
| Loyalty | Redemptions, repeat visits | Revealed preference | `booking` |
| Mutes | Hard "no" | **Overrides all** at recompute | `connector` / explicit |

**Venue-link (1b) evidence** carries `venue_link` provenance: a strong booking gradient with single-venue intent and no taste breadth. It **does not generalise** across the graph until merged with a connector-linked profile.

---

## 4. What NEVER flows

- **Raw connector payloads to venues.** Venues see *derived intelligence* (profile, taste, spend history, return likelihood) — never a guest's raw Spotify library or Instagram graph.
- **Guest-level affinity across tenants.** Only anonymised aggregates roll up to the cross-tenant layer, and only **above minimum tenant/guest thresholds** (k-anonymity); below threshold, the cell is suppressed.
- **Purchased/scraped data at guest level.** Catalog-only.
- **Signal without a consent grant.** `affinity_evidence` has a hard FK to `consent_grant`; no grant → no write.
- **Un-provenanced signal.** Every evidence row names its source, so weighting/generalisation rules are enforceable.

---

## 5. Consent basis & ownership

| Question | Position |
|---|---|
| **Basis** | Class 1: connector OAuth + app ToS. Class 1b: checkout terms (observed behaviour, permitted). Class 2: tenant DPA. Class 3: non-personal. Class 4: per-request scope. |
| **Ownership** | The **tenant owns its per-tenant graph.** A-List owns the A-List tenant graph; a venue owns its own. Atlas operates the substrate and the anonymised cross-tenant layer. |
| **Cross-tenant** | Anonymised + aggregated above thresholds only; no tenant can read another tenant's guest-level rows (enforced by RLS + lake-side aggregation, never OLTP joins). |
| **Erasure / portability** | First-class: tombstone the evidence + purge derived rows, keep a redacted provenance record. Auditable trail via `identity_merge_log` and the consent ledger. |
| **Venue-link line item** | The contract explicitly names what 1b bookings write, since the guest is the *venue's* customer at that moment and only becomes an A-List user post-booking. |

---

## 6. Identity join mechanics (the class-1b path)

The canonical "dirty identity" case: booking happens **before** any A-List account.

1. **Provisional guest uid** created at booking — name + contact + payment (a table booking requires these operationally, so the **join key is free**). Phone primary (higher uniqueness; venues need it), email secondary. Apple/Google Pay captures all three, verified, in one tap — no form.
2. **Merge on signup** via `merge_identities` on verified phone/email. **Stripe card fingerprint** corroborates. The **Wallet-pass ID** is a durable device-linked identifier and a pre-app update channel.
3. **Provisional-to-general promotion:** venue-link evidence stays single-venue until the merge lands, then generalises under the merged profile's consent.

---

## 7. What the venue sees (derived only)

- **Clean demand** — routed, crew-sized, budget-qualified bookings; deposits held and split-pay resolved before doors.
- **Guest intelligence** — who came, why, what they like, who they brought, what they spent, return likelihood.
- **Its own funnel** — the venue-link carries venue/campaign ID, so the venue sees its own conversion — the venue-facing analytics story *before* it is a paying tenant.
- **Never** raw connector data, another venue's guest rows, or below-threshold cross-tenant detail.

---

## 8. Open items for the checkpoint

- Confirm the class-1b consent line wording (legal review before any venue conversation).
- Set the concrete k-anonymity thresholds (minimum tenants and guests per cross-tenant cell).
- Confirm phone-primary vs email-primary join key against the first anchor venue's operational reality.
- Decide the retention window for raw connector payloads in the lake before they're reduced to evidence.
