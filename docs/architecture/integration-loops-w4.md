# W4 — Integration Loop Stories

**Status:** Draft v1 (for the Jul-24 target)
**Owner:** Adrian
**Maps to:** Project Plan §8 (W4), Q2 (first five integrations); deck slide 8 (one loop); `primitive-api-spec.md`, `alist-journey-w2.md`, `data-contract-alist-atlas.md`.
**Purpose:** three concrete, end-to-end stories showing how the **first five integrations** — **Stripe, Spotify, Instagram, Klaviyo, Square** — chain across primitives to close the flywheel. Each step names the integration, the primitive calls, the evidence emitted, and *what the venue sees*. These are the "explain the platform better than the primitive count" slides.

**The flywheel each loop feeds:** every booking → better recommendations → more bookings → better intelligence → better hospitality → more guests → more bookings.

---

## Loop 1 — Instagram ad → repeat visit (the canonical loop)

*The weakest part of the old pitch was "where does the intelligence come from?" This loop answers it: guests choose A-List, and every action becomes evidence.*

| # | Stage | Integration | What happens | Primitive calls | Evidence | Venue sees |
|---|---|---|---|---|---|---|
| 1 | **Reach** | Instagram | Venue runs an IG campaign with a promoter code; guest taps "Book on A-List" | `POST /v1/attribution/link` | — | Funnel reach ↑ |
| 2 | **Sign up** | — | Apple/Google sign-in; verified phone/email | `POST /v1/guests`, `.../links` | — | — |
| 3 | **Taste** | Spotify | One-connector onboarding; artists/genres land in the profile | `POST /v1/consent`, `connectors/spotify` → sync → `POST /v1/evidence` | affinity (`connector`) | — |
| 4 | **Discover** | — | Taste-ranked tables for tonight | `GET /v1/guests/{id}/recommendations` | — | Demand forming |
| 5 | **Book** | Stripe | Hold table; crew splits the deposit | `POST /v1/bookings`, `.../deposit`, `.../split-pay` | booking | Clean, crew-sized booking |
| 6 | **Spend** | Square | POS tab syncs post-visit; spend joins the profile | `POST /v1/webhooks/square` | spend (`pos`) | Known spend, tab size |
| 7 | **Return** | Klaviyo | Audience Studio segments the cohort; winback lands as *discovery* | `POST /v1/audiences:query`, `POST /v1/campaigns` | — | Guest intelligence + next visit |

**Proves:** props 1 (one profile discovery→spend), 3 (taste-driven demand), 6 (own the guest). Closes the "Instagram ad → signup → Spotify taste → booking → POS spend → CRM retargeting" chain from the deck. **Integrations exercised: all five.**

---

## Loop 2 — Venue-link web booking → app conversion → identity merge (class 1b)

*A guest with no A-List account books from the venue's Instagram bio. The take-rate needs the completed booking, not the signup — app conversion comes after.*

| # | Stage | Integration | What happens | Primitive calls | Evidence | Venue sees |
|---|---|---|---|---|---|---|
| 1 | **Link** | Instagram | Venue IG/bio link opens that venue's table map on A-List **web** — no signup wall | `POST /v1/attribution/link` (venue/campaign ID) | — | Own funnel conversion |
| 2 | **Provisional book** | Stripe | Name + phone + payment in one Apple/Google Pay tap (verified) → provisional guest | `POST /v1/guests` (provisional), `POST /v1/bookings`, `.../split-pay` | booking (`venue_link`) | High-intent booking |
| 3 | **Spend** | Square | Tab runs; spend attaches to the provisional uid | `POST /v1/webhooks/square` | spend (`venue_link`) | Spend, single-venue |
| 4 | **Convert** | — | Confirmation + Wallet pass ("track your table, split-pay, rewards"); post-visit loyalty window | `POST /v1/entitlements` (Wallet), `POST /v1/loyalty/accrue` | loyalty | Repeat hook |
| 5 | **Sign up** | Spotify | Guest opens the app later; connects Spotify | `connectors/spotify` → `POST /v1/evidence` | affinity (`connector`) | — |
| 6 | **Merge** | Stripe | `merge_identities` on verified phone/email; **card fingerprint** corroborates | `POST /v1/guests/{id}/merge` | — | One unified guest |
| 7 | **Generalise** | — | Venue-link evidence, previously single-venue, now generalises under the consented profile | (recompute) | — | Richer profile |

**Proves:** props 2 (consumer app + operator share truth), 4 (no rip-and-replace — books through existing Stripe/POS), 6. The canonical **dirty-identity** case: `venue_link` evidence stays single-venue until the merge lands, then generalises. **Integrations: Instagram, Stripe, Square, Spotify.**

---

## Loop 3 — Artist announce → winback → filled room (relationship monitoring)

*"123 guests love Afro House and haven't visited in four months. Black Coffee just announced. Est. revenue $146k. Reach them?" — data becomes an opportunity, not a dashboard.*

| # | Stage | Integration | What happens | Primitive calls | Evidence | Venue sees |
|---|---|---|---|---|---|---|
| 1 | **Signal** | — | Venue announces Keinemusik; Atlas already knows who follows them (Spotify/IG affinity) | `PUT /v1/entities/{id}` (event), `GET /v1/venues/{id}/at-risk` | — | Lapsing Afro-House cohort surfaced |
| 2 | **Segment** | — | Audience Studio: love Afro House · lapsed 4mo · spend >$1,500 · groups of 4–8 | `POST /v1/audiences:query` → count + **est. revenue** | — | Opportunity, not a list |
| 3 | **Reach** | Klaviyo | Delivered as **discovery** ("ANOTR is playing at Delilah next Friday"), never a blast | `POST /v1/campaigns`, `POST /v1/winback/trigger` | — | Targeted, low-spend reach |
| 4 | **Plan** | — | Guest opens it, pulls in crew; recs re-rank for the crew | `PUT /v1/crews/{id}/members`, `POST /v1/recommendations:crew` | crew | Crew-sized demand |
| 5 | **Book** | Stripe | Table held; split-pay locked before doors | `POST /v1/bookings`, `.../split-pay` | booking | Recovered booking |
| 6 | **Spend** | Square | Tab confirms the winback converted | `POST /v1/webhooks/square` | spend | Realised revenue vs estimate |
| 7 | **Learn** | — | Loop measures which winback signal/DJ actually recovered guests | `POST /v1/venues/{id}/closeout` → `usage_event`, `GET /v1/reports/{metric}` | — | "Which DJs create repeat customers?" |

**Proves:** props 3 (taste-driven demand routing), 7 (A-List is the proof layer — the taste graph is what makes this targetable). Turns BI §3.6 (recover guests before they're gone) + §4 (Audience Studio opportunities) into a closed loop. **Integrations: Spotify (affinity source), Instagram (affinity), Klaviyo (delivery), Stripe, Square.**

---

## How the loops reinforce each other

- **Loop 1** creates the account-linked taste that **Loop 3** later targets.
- **Loop 2** converts venue-owned demand into A-List accounts, feeding **Loop 1**'s taste graph.
- **Loop 3**'s realised-vs-estimated revenue sharpens the recommender that powers **Loop 1** and **Loop 2**.
- All three write only **consent-tagged evidence** through primitives (data-contract §3), and all three show the venue **derived** intelligence only (§7) — never raw connector data.

**Integration coverage:** Stripe and Square appear in all three (money + spend are the ground truth); Spotify is the taste anchor; Instagram is the reach/attribution rail; Klaviyo is the delivery rail that makes the venue's existing stack smarter (prop 4 — no rip-and-replace).

---

## Open questions for the checkpoint

- **Take-rate trigger** — confirm it fires on the completed booking (Loops 1–3 assume `usage_event` at booking/closeout), including class-1b venue-link bookings.
- **Winback attribution** — how do we attribute a recovered booking (Loop 3) to the campaign vs organic return, for the "which DJ/promoter creates repeat customers" report?
- **Estimated-vs-realised revenue** — surface the delta back to the venue (builds trust in Audience Studio estimates)?
- **Square vs Lightspeed** — lock the POS for the spend step across all three loops (plan Q2).
