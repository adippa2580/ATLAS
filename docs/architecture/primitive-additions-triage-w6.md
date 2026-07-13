# W6 — Primitive Additions Triage

**Status:** Draft v1 (for the Jul-31 target)
**Owner:** Adrian + Jack
**Maps to:** Project Plan §7; `primitive-api-spec.md` (the 23 primitives).
**Purpose:** triage the candidate hub additions so the **"23 primitives, one contract"** architecture story stays stable. Most candidates are **capabilities *inside* existing primitives**, not new primitives — the capability map absorbs the detail.

**Triage buckets:**
- **[CAP]** capability inside an existing primitive (default)
- **[NEW]** genuinely a new primitive (raises the count — high bar)
- **[INT]** an integration/connector, not a primitive
- **[LATER]** deferred beyond the current phases

---

## 1. Guest hub candidates

| Candidate | Verdict | Lands in / notes |
|---|---|---|
| Taste connector onboarding | **[CAP]** | Taste Connectors (#3) — progressive onboarding UX |
| Crew graph | **[CAP]** | Already a primitive (Crew Graph #5) |
| Entitlement wallet | **[CAP]** | Already a primitive (Entitlement Wallet #6) |
| Trust score | **[CAP]** | Already a primitive (Trust & Reputation #8) |
| Split-pay preferences | **[CAP]** | Split-Pay (#12, Ops) — per-guest default share/settings |
| Nightlife identity / profile badges | **[CAP]** | Identity & Profile (#1) — presentation layer |
| "See what friends are interested in" | **[CAP]** | Crew Graph (#5) + Discovery (#18) — social surface |

**No new primitives.** Guest hub is already the richest; additions are capabilities.

---

## 2. Ops hub candidates

| Candidate | Verdict | Lands in / notes |
|---|---|---|
| Table inventory | **[CAP]** | Inventory & Floor Map (#10) |
| Floor map | **[CAP]** | Inventory & Floor Map (#10) |
| Host stand | **[CAP]** | Door List / Check-in (#15) |
| Deposits / minimums | **[CAP]** | Deposits & Minimums (#11) |
| Closeout | **[CAP]** | Closeout / Settlement (#16) |
| POS / tab sync | **[CAP]/[INT]** | Tab/POS Sync (#13) primitive; Square/Lightspeed are the **[INT]** |
| Door list | **[CAP]** | Door List / Check-in (#15) |
| **Demand forecasting** | **[NEW?] → [LATER]** | Not the same as Demand *Routing* (#14, real-time crew ranking). Forecasting is analytical/predictive. **Recommendation:** start as a **[CAP] report** under Reporting/BI (#22); promote to a **[NEW]** primitive only if it grows its own write API and consumers. Deferred to Phase 03+. |
| Nightly revenue | **[CAP]** | Reporting & Benchmarks (#22) — a report, not a primitive |

**Watch item:** *demand forecasting* is the one candidate with a plausible path to a 24th primitive. Hold it as a report until it earns its own contract.

---

## 3. Marketing hub candidates

| Candidate | Verdict | Lands in / notes |
|---|---|---|
| Promoter tracking | **[CAP]** | Attribution (#20) — promoter code is an attribution dimension. (Note: plan §7 suggested "Creator network"; folding into Attribution keeps the count stable.) |
| Ad attribution | **[CAP]** | Attribution (#20) |
| Referral links | **[CAP]** | Attribution (#20) |
| Drop pages | **[CAP]** | Discovery (#18) + Attribution (#20) — a landing surface |
| Lifecycle campaigns | **[CAP]** | Lifecycle / CRM (#19) |

**No new primitives** — the Marketing hub's Attribution primitive absorbs promoter/referral/ad-tracking as dimensions.

---

## 4. Summary

| Bucket | Count | Examples |
|---|---|---|
| **[CAP]** | ~18 | Everything above except the two below |
| **[INT]** | — | POS connectors (Square/Lightspeed) — already tracked in Q2/Q3 |
| **[LATER]/[NEW?]** | 1 | Demand forecasting (report → maybe primitive later) |

**Result: the count stays at 23** for Phase 01/02. Only *demand forecasting* is a candidate 24th, and only if it develops its own API surface — decided later, not now.

**Why this matters:** "23 primitives, one contract" is an architecture *and* a sales story (W5, deck). Every capability we can fold into an existing primitive protects that story; every new primitive dilutes it. The bar for **[NEW]** is: it needs its own write path, its own consumers, and its own auth scope that don't fit an existing primitive.

---

## 5. Open questions for the checkpoint

- Confirm **demand forecasting** stays a Reporting/BI capability for now (not a new primitive).
- Confirm **promoter tracking** folds into Attribution rather than a standalone "Creator network" primitive (plan §7 had it as a candidate primitive).
- Any candidate that Jack thinks *must* be a first-class primitive for a venue conversation? (That's the real test for **[NEW]**.)
