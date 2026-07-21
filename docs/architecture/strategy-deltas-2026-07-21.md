# Strategy deltas — 2026-07-21 (adopted pending Jack ratification)

**Source of truth:** Atlas_Project_Plan.md v1.2 + workstream docs (ATLAS MAIN folder / Confluence, all under "Project Atlas PRD"). All W1–W8 proposals were adopted as working decisions on 2026-07-21 without the checkpoint; Jack review is async. Three hard gates remain before execution: venue conversations (W7 rates), external deck use, and the crew-composition build commit.

This file translates those decisions into repo terms: what the codebase already covers, what diverges, and what to build next.

---

## 1. Already aligned (no action)

- **W3 integration slate** = built adapter set: Stripe, Spotify, Instagram, Klaviyo, Square (stub mode). Square vs Lightspeed stays open against the anchor venue's stack.
- **Venue-link (class 1b) journey** — `docs/architecture/alist-journey-w2.md` §7 already specs it; strategy side converged independently. Canonical decision confirmed 2026-07-21: no signup wall before checkout; conversion at confirmation + post-visit.
- **Door/check-in** primitive exists — covers one of the two W6 pull-forwards.
- **Consent-revoke recompute** (P0 sprint) matches data-contract clause: revocation tombstones connector evidence from recomputation.

## 2. Divergences to reconcile (Jack review items)

1. **Crew-node learning loop.** Adopted W2 spec (§4, strategy side): crew-level bookings write evidence against the crew node from day one — composition is the cold-start prior, crew history the posterior. Repo (`alist-journey-w2.md` §6.3) defers learning to Phase 05+. Decide: pull forward a minimal crew-evidence write (cheap: bookings already carry crewId) vs hold the Phase 05 line.
2. **Per-member booking weighting.** `crew-blend.service.ts` omits §6.2's `w_m` (booking-backed member up-weight); evidence quality rides only in `GuestAffinity.score`. Acceptable if the recompute worker's weighting is confirmed; document or implement.
3. **W2 doc unification.** Two W2 docs exist (repo `alist-journey-w2.md` 2026-07-13; strategy `AList_User_Journey_Spec.md` 2026-07-21). Substance agrees. Strategy doc adds: express-pay-first identity capture (Apple/Google Pay sheet as the entire identity minimum), Wallet-pass ID as durable merge key, instrumentation set (S2 connector funnel, crew-adjust acceptance lift, V3-vs-V4 conversion, 30-day merged-profile rate). Fold these into the repo doc and retire the duplicate.

## 3. New build items (backlog, in priority order)

1. **Venue-link web surface (class 1b)** — venue-branded table map (V1), express-pay checkout (V2) creating a provisional guest uid keyed on verified phone/email, booking + attribution evidence with `venue_link` provenance, Wallet pass issuance (V3), post-visit loyalty message (V4). Merge on later signup via the existing `merge_identities` path + card-fingerprint corroboration; merge logged + reversible. Provenance rule: venue-link evidence does not generalise across the graph pre-merge. *Depends on P0 hardening landing (idempotent bookings, integer money, webhook HMAC).*
2. **Promoter tracking** (second W6 pull-forward, Phase 01–02) — Creator-network capability on the existing attribution rails (venue/campaign IDs). Day-one parity gap vs Fourvenues.
3. **Take-rate metering hooks (W7)** — closeout already emits `usage_event`; extend to per-booking take-rate with path (A/B) + campaign dimensions. Rates are ⚠ placeholders (10% tables / 8% tickets) until set with Jack; no venue conversation before that.
4. **Instrumentation set (W2 §5)** — the four proof numbers: connector funnel, crew-adjust acceptance lift, web→app conversion by window, merged-profile rate at 30 days.

## 4. References

- Confluence: "Project Atlas PRD" → Project Plan v1.2, W1–W7 pages, "Checkpoint pre-read" (Jack's async review list).
- Deck: `Atlas_Deck_ATELIER_v2.2.pptx` — §9 changelist verified + finalised 2026-07-21; external use gated on Jack.
