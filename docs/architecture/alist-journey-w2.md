# W2 — A-List User Journey (screen-level), mapped onto Atlas primitives

**Status:** Draft v1 (for the Jul-24 target; Jack review)
**Date:** 2026-07-13
**Owner:** Adrian
**Maps to:** Project Plan §4 (canonical booking flow), Q4/Q5, §10 risks; deck slides 5–8 (crew, flow, onboarding, one loop); `primitive-api-spec.md`; `atlas-system-design.md` §3.3.
**Purpose:** turn the five-stage flow into a screen-level spec where **every screen names the primitive calls it makes and the evidence it emits** — proving A-List is buildable entirely on the public tenant contract. Includes the **crew taste-composition (blend) interface**, the top design priority because the whole flow depends on it.

**Design rule (from the pitch):** *the consumer gets value before the venue does.* Someone should think "even if I never book a table, I want this app." So discovery, artist-follows, crew planning, and taste identity must be useful with zero bookings.

---

## 0. Onboarding — "no four-login wall" (deck slide 7)

Progressive; never a wall of four OAuth screens (Q4). Measure drop-off from day one (§10 risk).

| Screen | Guest action | Primitive calls | Evidence |
|---|---|---|---|
| **Welcome** | Continue with Apple/Google | `POST /v1/guests` (provisional→resolved), `POST /v1/guests/{id}/links` (verified phone/email) | — |
| **One connector** | Connect **Spotify** (only) | `POST /v1/consent`, `POST /v1/connectors/spotify/authorize` → `/callback` → sync | affinity (`connector`) |
| **Quiz fallback** | 30-sec taste quiz (if they skip Spotify) | `POST /v1/connectors/quiz` | affinity (quiz) |
| **First picks** | See tonight's personalised recs immediately | `GET /v1/guests/{id}/recommendations?context=tonight` | — |

Later connectors (Instagram, etc.) are **earned at moments of value** — "connect Instagram to sharpen tonight's picks" — never up front.

---

## 1. PLAN — hub: Guest (deck slide 6)

*Open app · date · taste filters · pick the vibe · **pick the crew***

| Screen | Guest action | Primitive calls | Evidence |
|---|---|---|---|
| **Home / discovery** | Browse artists, venues, events in town | `GET /v1/entities?kind=&q=`, `GET /v1/guests/{id}/recommendations` | — |
| **Follow** | Follow an artist / venue | `POST /v1/evidence` (signal `follow`) | affinity (`connector`/app) |
| **Date & vibe** | Pick date, set vibe filters | (client state → passed to routing) | — |
| **Pick crew** | Select people (the differentiator) | `POST /v1/crews`, `PUT /v1/crews/{id}/members` → recompute | crew |

**Key rule (deck slide 5):** crew is an **input, not an invite**. Selecting or changing the crew re-runs recommendations. Four house-heads with a $2k table see a different DJ and a 4-top; eight with birthday energy see tickets, a cheaper table, and a room that takes a cake.

---

## 2. ADJUST & ROUTE — hub: Guest + Ops

*Recs re-rank for crew size, taste, budget, availability · room routed*

| Screen | System action | Primitive calls | Evidence |
|---|---|---|---|
| **Crew-adjusted recs** | Re-rank for the crew | `GET /v1/crews/{id}/affinity` → `POST /v1/recommendations:crew` → `POST /v1/routing/rank` | — |
| **Options list** | Show taste-ranked tables/tickets that fit size + budget + availability | `GET /v1/venues/{id}/availability?date=&party=&crew=` | — |

This is the stage the **crew-blend interface** (§6) powers. Every crew edit loops back to §1's `PUT members` → re-rank here.

---

## 3. BOOK & PAY — hub: Ops + Guest

*Booking holds the table · split-pay locks each share · pushed to every crew member*

| Screen | Guest action | Primitive calls | Evidence |
|---|---|---|---|
| **Confirm booking** | Hold the table/tickets | `POST /v1/bookings` (`Idempotency-Key`) → `held` | booking |
| **Deposit / minimum** | See + accept deposit/min | `POST /v1/bookings/{id}/deposit` | — |
| **Split-pay** | Lock each member's share | `POST /v1/bookings/{id}/split-pay` (per-share Stripe PIs) | — |
| **Push to crew** | Each member pays their share | `GET /v1/bookings/{id}/payments`, `POST /v1/webhooks/stripe` | — |
| **Confirmed + Wallet** | Booking `confirmed`; add Wallet pass | booking state → `confirmed`; wallet_pass_id issued | — |

The Wallet pass is a durable device-linked identifier and a pre-app update channel (ties to identity-merge, data-contract §6).

---

## 4. LIVE — hub: Ops

*Floor management seats them · tab opens*

| Screen (venue-side) | Action | Primitive calls | Evidence |
|---|---|---|---|
| **Door / check-in** | Mark arrival, check entitlements | `GET /v1/venues/{id}/doorlist`, `POST /v1/door/checkin` | attend |
| **Seat + open tab** | Booking → `seated`; POS tab opens | booking state; `GET /v1/bookings/{id}/tab` | — |
| **Spend** | Tab activity via Square | `POST /v1/webhooks/square` | spend (`pos`) |

---

## 5. WRAP — hub: Marketing

*Loyalty · reputation · CRM · guest intelligence out*

| Screen | Action | Primitive calls | Evidence |
|---|---|---|---|
| **Loyalty credit** | Award credit / entitlement | `POST /v1/loyalty/accrue`, `POST /v1/entitlements` | loyalty |
| **Reputation prompt** | Rate the night | `POST /v1/trust/events` | — |
| **Closeout** | Reconcile + meter take-rate | `POST /v1/venues/{id}/closeout` → `usage_event` | — |
| **CRM update / winback armed** | Venue gets clean demand + guest intelligence | `POST /v1/audiences:query`, `POST /v1/winback/trigger` | — |

The venue only ever sees **derived** intelligence here — never raw connector data (data-contract §7).

---

## 6. Crew taste-composition (blend) — the interface (W2, load-bearing)

The whole flow depends on turning member affinities into a **crew affinity** the recommender can rank against. This is unsolved; the strategy is **fix the interface now, swap the implementation later** so nothing downstream churns.

### 6.1 Fixed interface

```
blend(crew_id) -> crew_affinity[
    { subject_type, subject_ref, blended_score, confidence }
]
```
- **Input:** each member's `guest_affinity` (scores + pgvector embeddings), plus the crew's context (party size, budget band, vibe tags, availability).
- **Output:** `crew_affinity` rows consumed by `POST /v1/recommendations:crew` and `POST /v1/routing/rank`.
- **Invariants (must hold for every implementation):**
  1. **Mutes are a hard union** — if *any* member mutes a subject, it is excluded for the crew.
  2. **Time-decay respected** — recent member signal outweighs old.
  3. **Bookings weigh most** — paid-action affinity dominates browsing.
  4. **Deterministic + explainable** — every recommendation can name why (for guest trust).

### 6.2 MVP implementation — heuristic (Alpha)

Ship this for Phase 01; it's the §10 fallback made concrete.

1. **Hard filters first:** union of member mutes removed; drop anything outside crew budget/size/availability (cheap, explainable).
2. **Blend score:** weighted combine of member affinity vectors —
   `blended = Σ_m w_m · decay(affinity_m)`, where `w_m` up-weights members with **booking-backed** affinity over browse-only, and normalises by crew size.
3. **Consensus boost:** subjects multiple members share get a super-linear boost (a crew is more than the average — shared taste is the signal).
4. **Confidence:** low when members are sparse/conflicting → recommender widens to safe crowd-pleasers (vibe-tag matches) rather than over-fitting.

Crew affinity is **explicitly not the average of members** (deck slide 5) — the consensus boost + booking-weighting is what makes it "learned-ish" before a model exists.

### 6.3 Learned path (later — Phase 05+)

Once enough **crew-level bookings** exist, replace §6.2's fixed weights with a model trained on *what crews actually booked* (the deck's "the blend is learned"). The interface (§6.1) and invariants are unchanged, so only the internals of `blend()` move. Candidate: a light ranking model over member-embedding aggregates + crew context, supervised by realised bookings/spend.

### 6.4 Why this is the top risk

If blending is hard, the crew differentiator degrades to plain filters (size/budget/vibe) — still usable, but it loses the "your crew changes the night" magic. Parking the model behind a stable interface means we can ship Alpha on the heuristic and upgrade without a flow rewrite.

---

## 7. Variant — venue-link (class 1b) journey (no A-List account)

Venue IG/bio link → A-List **web**, no signup wall (data-contract §6, plan §3.1).

1. Link opens the venue's table map directly — `POST /v1/attribution/link` carried the venue/campaign ID.
2. Book with name + phone + payment (Apple/Google Pay, verified, one tap) → `POST /v1/guests` **provisional**, `POST /v1/bookings`, `POST /v1/bookings/{id}/split-pay`.
3. Evidence written under the provisional uid with `venue_link` provenance — **single-venue, does not generalise**.
4. **App conversion post-booking:** confirmation + Wallet pass ("track your table, run your tab, split-pay, rewards next visit"), second window post-visit via loyalty credit (WRAP).
5. On later app signup → `POST /v1/guests/{id}/merge` on verified phone/email; provisional evidence generalises under the merged, consented profile.

---

## 8. Measurement (Q4 — connector drop-off, from day one)

Instrument each onboarding step: welcome → connector prompt → connected / quiz / skipped → first-recs viewed → first booking. Track the progressive-onboarding hypothesis (one connector at signup, earn the rest) against a wall-of-four baseline. Feeds the §10 "connector drop-off" watch item.

---

## 9. Open questions for the checkpoint

- **Crew-blend weights** — confirm the §6.2 booking-vs-browse weighting and consensus-boost shape before Alpha lock.
- **Confidence fallback** — how wide should low-confidence recs go toward crowd-pleasers vs staying narrow?
- **Wallet pass as pre-app channel** — confirm it's the primary update rail for class-1b guests pre-signup.
- **Quiz depth** — is a 30-second quiz enough cold-start signal, or do we need a lightweight second touch?
- **Crew edit latency** — target for the `PUT members → re-rank` loop (should feel instant; cache crew_affinity in Redis, invalidate on member change).
