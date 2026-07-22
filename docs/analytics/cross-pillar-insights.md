# ATLAS Cross-Pillar Insights Catalog

_Synthesis of a six-analyst pass (Owner/GM & Finance, Marketing/CRM, VIP Host & Guest
Experience, Floor Ops & Yield, Beverage/F&B, Talent/Programming). Every insight is a
JOIN across ≥2 of the seven data pillars, grounded in the real `prisma/schema.prisma`.
Insights that multiple roles independently arrived at are marked ⚑ — that convergence is
the signal that they're the highest-leverage._

## 0. Why these exist — the pattern

For any incumbent, taste, money, identity, consent, the social graph, inventory economics,
and attribution live in **physically separate systems** (Spotify, POS, PMS, ESP, ad
platform, reservation book). None of them can compute the join. ATLAS's one contribution is
that all seven pillars sit in one tenant-scoped, consent-tagged graph keyed on a resolved
`Guest.id` that survives the provisional→app-account merge. **A-List generates the signal;
ATLAS makes the join.** That join *is* the product — and the flywheel the pitch describes
("Atlas gets smarter every booking") is literally the taste graph compounding.

The recurring join legs:
- **taste** — `GuestAffinity(subjectType, subjectRef, score, muted, decayedAt)` derived from
  append-only `AffinityEvidence(signal, provenance, weight, observedAt)`; `CrewAffinity(blendedScore, confidence)`.
- **money** — `Booking.id → Tab(total, lineItems, closedAt)` and `Payment(amount, status)`.
- **identity/consent** — `Guest(provisional)`, `IdentityLink(kind, verified)`, `IdentityMergeLog`, `ConsentGrant(scope, revokedAt)`.
- **social** — `Crew`, `CrewMember(role)`, `Booking.crewId`.
- **inventory** — `Inventory(capacity, minSpend, deposit)`; `Booking(status, date, partySize, inventoryId)`.
- **attribution** — `AttributionLink(code, campaignId, venueId) → Booking.attributionId`; `Campaign(channel)`.
- **trust** — `TrustEvent(kind, weight)`; `Entitlement(kind, state, expiresAt)`.

---

## 1. The flywheel spine

Five correlations are what make "Atlas gets smarter every booking" *true* rather than a
slogan. If only five things get instrumented, these are them:

1. **Affinity demand index** — follows/listens are demand *before* it becomes a booking.
2. **Identity match-rate** — the ceiling on how much of the above you can measure or act on.
3. **Crew reach** — the multiplier that turns one booker into a table and N new guests.
4. **Spend-linked taste** — POS spend fanned back into the graph closes the loop.
5. **Attribution surviving merge** — proves the loop's ROI end to end.

---

## 2. Convergent high-leverage correlations (ranked)

### ⚑ A. Affinity as a leading indicator of demand
_Roles: Owner #4, Marketing #2, Floor #2, Talent #1/#2/#8._
- **Join:** `AffinityEvidence(subjectType=artist|genre, signal∈{follow,listen}, provenance=connector, observedAt)` ⋈ `GuestAffinity(score, muted=false)` ⋈ guests localized to a `Venue.city` (via prior `Booking`) ⋈ the booking calendar (`Booking.date ⋈ attributionId → Entity`). Compare **latent demand** (summed affinity) to **realized** (bookings/covers).
- **Why it's #1:** Spotify/IG follows land as evidence weeks before a ticket sells. This is the one signal no reservation book or POS has — it's upstream of the transaction.
- **Drives:** what to program, what to price, how much inventory to hold vs. release, how to staff — all set *before* the booking curve reveals itself.
- **Output:** a per-city demand index per artist/genre; "high-affinity, low-conversion" nights flagged for review (programming/pricing mismatch); a "who to book next" queue (below).
- **Value:** contribution margin per night, not just covers; first-mover on artist fees.

### ⚑ B. Identity match-rate / merge — the foundational enabler
_Roles: Owner #3 ("dark revenue"), Marketing #4 ("reach ceiling"), Floor #8, VIP #4._
- **Join:** `Guest(provisional)` + `IdentityLink(kind, verified)` + `ConsentGrant(revokedAt IS NULL)` ⋈ that guest's `Tab.total`/`Payment.amount`. Track `Σ spend on unmerged/provisional guests ÷ total spend` ("dark revenue") and `addressable ÷ intended` per audience ("reach ceiling").
- **Why it's foundational:** it *gates the accuracy of almost everything else* — LTV, attribution, trust scoring, targetable reach. Provisional venue-link guests don't generalize until a verified phone/email/card arrives.
- **Drives:** whether to invest in the merge path and connector onboarding; every point of match-rate converts anonymous cash into measurable, retargetable LTV.
- **Output:** a "dark revenue $/%" finance line; audiences reported as matched/addressable/suppressed, not just size.
- **Value:** retention + valuation (dark revenue is un-modelable in a DCF); raising match-rate is often the highest-ROI growth work because it uncaps every campaign.

### ⚑ C. Crew super-connectors & crew-amplified draw
_Roles: Owner #2 ("crew halo"), Marketing #3 ("virality"), VIP #5, Talent #3, Beverage #1._
- **Join:** `Crew.ownerGuestId`/`CrewMember(role)` ⋈ `Booking(crewId, partySize)` ⋈ distinct downstream `Guest.createdAt`/independent bookings of members ⋈ `Tab.total` ⋈ `CrewAffinity(blendedScore, confidence)`.
- **Insight:** a modest-personal-spend guest who assembles a $6k table every Friday and seeds N first-time guests is worth far more than a solo whale. Crews book tables, hit `minSpend`, split-pay, and fan out installs (wedge #3).
- **Drives:** comp the *hub of the social graph* as an acquisition investment; book artists that light up whole crews (blended taste), not just equal solo-follow counts.
- **Output:** a "connector score" (distinct first-timers seeded per booker, 90d); a crew-VIP host flag; a "crew reach" column on the talent shortlist.
- **Value:** near-zero effective CAC on crew-seeded regulars; `partySize`-multiplied, pre-committed covers.

### ⚑ D. Risk-priced holds — Trust × deposit × spend history
_Roles: Owner #5, Floor #1/#8, VIP #3._
- **Join:** `TrustEvent(kind=no_show|positive, weight)` + `Booking.status=cancelled` history + lead time (`date − createdAt`) + `partySize` ⋈ `Inventory(deposit, minSpend)` ⋈ `Payment` reliability, gated on merged identity.
- **Drives:** deposit ladder by risk decile — waive for proven regulars (a *felt* courtesy), full deposit for cold long-lead large parties. Also door/overbooking decisions.
- **Output:** a per-booking risk score at hold time; deposit auto-set on `held→confirmed`.
- **Value:** no-show % is the single largest controllable yield leak; targeted deposits cut it without adding friction for loyal guests.

### ⚑ E. Silent whales — high value + decaying frequency
_Roles: Owner #7, Marketing #5 (winback timing), VIP #8._
- **Join:** high `AffinityEvidence(signal=spend)` weight / top `Tab.total` percentile ⋈ **rising** days-since-last `attend`/`book` ⋈ still-high `GuestAffinity(venue).score` ⋈ clean `TrustEvent`.
- **Insight:** top-decile spenders quietly lapsing are invisible on a covers-count dashboard because per-visit tab masks falling frequency. The winback trigger is the *convergence* of decay + a latent reason (favorite DJ announced), not a 90-day calendar.
- **Drives:** precision winback routed through the guest's own host first, not a blast.
- **Output:** a weekly "high-value at-risk" list ranked by trailing spend × lapse-probability, with the likely cause.
- **Value:** saving a handful of top-decile regulars/month beats dozens of median winbacks.

### ⚑ F. Min-spend / deposit calibration & spend-aware table routing
_Roles: Owner #5, Marketing #8, Floor #6/#7, VIP #2, Beverage #4/#8._
- **Join:** `Inventory(minSpend, deposit, capacity)` ⋈ realized `Tab.total`/`lineItems` per `Inventory.label × partySize × daypart` ⋈ `GuestAffinity`/spend history.
- **Insight:** `minSpend` is almost always mis-set vs. the realized spend distribution — leaving margin on chronically-beaten tables or suppressing bookings on over-priced ones. "Coasting" tabs (spend stops the instant it clears the minimum) are a distinct, catchable segment.
- **Drives:** re-price minimums/deposits to the right percentile (~p35–p40 to bind the tail without deterring the median); route the right table *tier* to the predicted spend band; next-round nudge on coasting tabs.
- **Output:** a monthly "minSpend realization" table per inventory item; a routing prior (`ops:routing:rank`) blending taste rank with a spend-clearance prior.
- **Value:** contribution per seat-hour with no new demand required.

### ⚑ G. Lifetime attribution by channel & talent (survives merge)
_Roles: Owner #8, Marketing #6, Talent #5._
- **Join:** `AttributionLink(code, campaignId) → Booking.attributionId → Tab.total` for the *first* booking, then follow the merged `Guest.id` across **all subsequent** (un-coded) bookings/tabs. For talent: attributed-night revenue minus same-venue/same-weekday non-attributed baseline = **lift**.
- **Insight:** channels/promoters self-report first-booking CPA, which flatters shallow sources. Repeat-spend LTV:CAC reshuffles budget materially. Attribution survives the provisional→app merge because identity resolution and attribution share the guest hub.
- **Drives:** fund channels/artists by acquired-guest LTV and net lift, not vanity CPA; the rebook/renegotiate/drop decision, provable to ownership.
- **Output:** cohort contribution-margin curves with payback month per channel; a talent-ROI scorecard (incremental covers, revenue/cover, sell-through, no-show-adjusted).
- **Value:** better blended CAC payback — the metric an acquirer underwrites.

### ⚑ H. Product/bottle mix by night × crew × taste
_Roles: Beverage #1/#2/#3/#7, Talent #4 (spend elasticity)._
- **Join:** `Tab.lineItems` (SKU→category map) ⋈ `Booking.date` (artist/genre night) ⋈ aggregated `GuestAffinity(genre)` of confirmed guests ⋈ `CrewAffinity` × crew size.
- **Drives:** par-stock and pre-chill to *this* night's booked taste (tequila-forward Latin night vs. champagne-forward headliner); pitch bottle service to high-propensity crews before doors; personalized table menus that trade known buyers up one tier; occasion/celebration detection → the champagne moment.
- **Output:** a 72-hour pre-order sheet; a host-stand attach card per `crewId`; per-guest "top-3 SKUs + one trade-up."
- **Value:** the exact lever the Outcomes dashboard tracks (bottle attach 18%→26%); average tab + margin mix, less premium waste.
- **Unlock required:** today spend evidence is fanned at *venue* grain only — see §4.2.

### I. Talent ROI, "who to book next," and lineup optimization
_Role: Talent #1–#8 (with Owner #4)._
- **Join:** latent demand (A) + crew reach (C), de-duplicated across artists by shared `guestId`, discounted by `TrustEvent(no_show)`, measured against `Inventory.capacity/minSpend`.
- **Drives:** three shippable surfaces — a per-city **"who to book next"** queue (latent demand + genre gaps + portability), a **talent-ROI scorecard** (lift vs. baseline, residency-slope), and a **lineup optimizer** (maximize the *union* of reachable guests/crews, not the sum — avoid booking two artists who share one fan base).
- **Value:** incremental covers + revenue/night, talent-cost efficiency, sell-out probability per candidate bill.

### J. Cross-venue portability & portfolio routing
_Roles: Owner #9, VIP #4, Talent #6._
- **Join:** `GuestAffinity(subjectType=venue)` and spend across `Venue` rows of one anchor tenant (RLS isolates *tenants*, not venues, so a group's guest graph is shared across its rooms) + k-anon cross-tenant benchmarks for markets not yet entered.
- **Drives:** cross-sell routing today (`routing/rank`); "new here, not new to us" greeting for a group regular's first visit to a sister room; affinity-validated site selection for the next venue.
- **Value:** the cheapest incremental revenue in the portfolio; de-risked expansion capex.

---

## 3. By role — where to point each persona first

| Role | Lead plays (this catalog) | The one number to instrument |
|---|---|---|
| **Owner / GM / Finance** | B (dark revenue), A (night contribution), G (CAC payback), J (portfolio) | Identity match-rate (gates LTV/valuation) |
| **Marketing / CRM / Growth** | A (taste-segment ROAS), C (crew virality), B (reach ceiling), G (LTV attribution), E (winback timing) | Addressable ÷ intended per audience |
| **VIP Host / Guest Experience** | "Who's walking in tonight" card (A+B+D+E), C (connector flag), H (predicted tab band) | Lifetime tab per resolved guest |
| **Floor Ops / Yield** | D (risk deposits), A (demand forecast), F (minSpend + hold/release), spend-pace turns | No-show % and occupancy/seat-hour |
| **Beverage / F&B** | H (mix by night/crew), F (min-spend gap), pace-of-spend next-round timing | Bottle attach rate by crew archetype |
| **Talent / Programming** | I (who-to-book / ROI / lineup), A (latent demand), C (crew reach), J (portability) | Follow→attend→spend conversion per artist |

---

## 4. Three data-model unlocks (flagged independently by the analysts)

These are the changes that convert several "computable per query" insights into served,
derived, real-time intelligence.

### 4.1 Append-only `BookingStatusEvent` (Floor Ops)
`Booking` carries only `createdAt`, `date`, and current `status` — no transition history. So
no-show/cancel *timing* (late-cancel vs. true no-show), seat→close timing, and release timing
are inferred, not measured. Add `BookingStatusEvent(bookingId, fromStatus, toStatus, at)`,
mirroring the append-only pattern already used for `AffinityEvidence`/`IdentityMergeLog`.
Sharpens D (risk deposits), F (turns), and hold/release.

### 4.2 Product-grain evidence fan-out + a `product` subject type (Beverage)
The POS→evidence loop (`tab.module.ts`) fans spend into the graph at **venue grain only**
(`subjectType=venue, subjectRef=venueId`); the per-SKU detail sits latent in `Tab.lineItems`
JSON and never becomes derived affinity. Add a `product` member to `SubjectType` and emit
per-line-item evidence keyed to a SKU/category `subjectRef`. This is what turns **all of
insight H** from per-query read-side joins into served `GuestAffinity`/`CrewAffinity` with a
product dimension — personalized menus, par-stock, upsell all become real-time.

### 4.3 Modeled talent cost (Talent)
Artist fee/booking cost is not a first-class field, yet true talent ROI (G, I) needs it.
Today it must live in `Entity.metadata` JSON or an ops annotation. A modeled `artist_cost`
(attributable like `Booking.attributionId`) makes the ROI scorecard exact rather than
annotated.

---

## 5. Instrument-first sequence

1. **Identity match-rate (B)** — gates the measurability of A, E, G. Foundation of the LTV/valuation story.
2. **Affinity demand index (A)** — proves the flywheel and immediately serves programming, pricing, staffing.
3. **Risk-priced deposits (D) + silent-whale list (E)** — fastest revenue-in / cost-out with fields that exist today.
4. **Taste-segment ROAS (A) + crew virality (C) + LTV attribution (G)** — the CAC story that funds growth.
5. **The three unlocks (§4)** — `BookingStatusEvent`, product-grain fan-out, `artist_cost` — to move H and the timing-sensitive insights from query-time to served.

---

_Full per-role analyses (each with exact joins, operational outputs, value, and moat) were
produced by the analyst pass; this catalog is the deduped, ranked synthesis. Every insight is
defensible for the same structural reason: it joins pillars that are separate systems for any
incumbent, on a consent-tagged, identity-resolved guest graph only ATLAS holds._
