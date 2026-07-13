# W7 — First Paid Wedge (one-pager)

**Status:** Draft v1 (for the Aug-7 target)
**Owner:** Adrian + Jack
**Maps to:** Project Plan Q3, Q7; deck slides 10–11, 13 (roadmap "Take-rate on", Q2 2027).
**Purpose:** what we sell first, to whom, and what the first customer pays for — without leading GTM with founder SaaS or platform pricing.

---

## 1. The wedge, in one line

**A-List booking take-rate is the first revenue** — no sales cycle, proves demand, venues pay **nothing up front**. Then **venue SaaS sold as "guest intelligence"** once we can walk into a venue with *their own demand data*.

This is a **two-step** wedge, sequenced deliberately (Q3).

---

## 2. Step 1 — Booking take-rate (first dollar)

| | |
|---|---|
| **Who pays** | The venue (or the guest, embedded) — on a **completed booking** |
| **What they pay for** | Demand: routed, crew-sized, budget-qualified bookings with deposits held and split-pay resolved before doors |
| **Why now** | No sales cycle; consistent with prop 4 (no rip-and-replace — books through their existing Stripe/POS). The venue risks nothing to say yes |
| **Metering** | `usage_event` on booking/closeout (`primitive-api-spec.md` #16); real-time billing when "Take-rate on" (roadmap Phase 04, Q2 2027) |
| **Framing** | Uber didn't sell dispatch software — it sold **more riders**. Atlas doesn't sell dashboards — it sells **more guests**, then better intelligence |

**Crucially:** venues aren't the first *customer* here — they're the **distribution partner** (pitch §"venues aren't the first customer"). The deal is: *"help us get your guests onto A-List, and we'll give you increasingly valuable intelligence."* That's a partnership, not a software sale.

---

## 3. Step 2 — Venue SaaS as "guest intelligence" (the expansion)

| | |
|---|---|
| **Who pays** | The venue / hospitality group, once we can show them their own demand data |
| **What they pay for** | **Business Intelligence for Hospitality** — know every guest, deliver better hospitality, grow revenue intelligently, run the business with confidence (BI doc §2). Audience Studio opportunities ("123 guests… est. $146k. Reach them?") |
| **Why it lands** | We walk in with *their* funnel and *their* guest intelligence already populated from Step 1 — not a promise of future value |
| **When** | Phase 04+, after take-rate proves demand |

**Positioning discipline (Q7):** GTM leads with the concrete wedge — **"Business Intelligence for Hospitality" / "we bring you new guests"** — never "the substrate." Substrate is the **closing-slide vision** for investors and platform partners, not the venue sales lead. One deck does both: wedge up front, substrate on the last slide.

---

## 4. What we explicitly do NOT lead with

- ❌ Founder SaaS / platform pricing as the opener.
- ❌ "We're building AI" — say "we're helping bring you new guests" (pitch §"the venue pitch").
- ❌ "Guest Intelligence" as the deck headline — lead with **Business Intelligence for Hospitality**; the outcome (revenue, repeat, smarter spend), not the mechanism (BI doc §2).
- ❌ "23 primitives" as the pitch — that's the architecture story, not the lead (plan §1).

---

## 5. The wedges that seed Step 1 (where the first users come from)

From the pitch — four wedges answer "where do the first users come from?":

1. **Venue distribution** — the venue *is* the marketing channel ("Book on A-List" in IG bio, QR, confirmations). Every touchpoint → an A-List user.
2. **Artists** — people say "I want to see ANOTR," not "I want to go to Delilah." Following artists drives demand.
3. **Groups** — one person books, six download. Every group multiplies acquisition.
4. **Discovery** — the app must be useful even if nobody books ("what should we do tonight?"). *That's a product, not an ad.*

---

## 6. The rule that de-risks it all

**The consumer must get value before the venue does.** Someone should think *"even if I never book a table, I want this app."* If clicking "Book with A-List" only makes an account and books a table, we've built another Tablelist (W5 risk). Discovery, artist-follows, crew planning, and taste identity are why A-List stays on the phone — and therefore why the take-rate, and then the SaaS, ever materialise.

---

## 7. Open questions for the checkpoint

- **Take-rate level** and who bears it (venue-absorbed vs guest-facing fee) — model against the first anchor venue's economics.
- **Step-2 pricing shape** — per-venue SaaS vs group tier vs usage-based on Audience Studio sends.
- **Trigger for Step 2** — how much demand data (bookings, guests, spend) must a venue accumulate before the intelligence pitch is compelling?
- **Distribution-partner terms** — what the venue commits to (bio link, QR, confirmations) in exchange for the intelligence, written into the W1 data contract.
