# Playbook: the personalization / offer model

Status: **ratified pattern** · Owner: Priya N. · Source outcome: *Lift personalization uplift to +22% spend* (achieved, Q2 2026)

This banks the winning personalization pattern so it can be reused across
surfaces instead of re-derived each time. Every act-now lever the platform ships
is an instance of this loop — this document is the loop.

## The loop

```
signal → evidence → affinity → segment → offer → outcome → (new signal)
```

1. **Signal.** A guest does something observable: connects Spotify, closes a tab,
   scans an entry-QR, attends on a booking. Each is captured as `AffinityEvidence`
   with a `provenance` (`connector | booking | venue_link | pos | agent`) and,
   where consent gates it, a `consentId`.
2. **Evidence → affinity.** Evidence folds (consent-gated, decayed) into
   `GuestAffinity` rows — a `(subjectType, subjectRef, score)` per guest. This is
   the moat: the taste graph no competitor can replay.
3. **Affinity → segment.** Guests cluster by their strongest non-muted affinity
   into addressable **taste-segments** (`GET /v1/audiences/taste-segments`). A
   segment is only addressable if the guest is **identity-matched** (non-provisional)
   **and** consented — reachability, not just interest.
4. **Segment → offer.** An offer is a template bound to a segment and a moment.
   The moment is what makes it convert; see *Timing* below.
5. **Offer → outcome.** Sends dispatch through the lifecycle adapter; results
   (open, book, attend, spend) become the next round of signal. Metering and
   attribution close the loop back to revenue.

## Where each lever plugs in

| Lever | Endpoint | Loop stage |
|---|---|---|
| Prompt Spotify connect at booking | `GET /v1/bookings/:id/connect-prompt` | signal (enrichment) |
| Instrument door / walk-in capture | `POST /v1/door/walk-in` | signal + identity |
| Extend entry-QR to all venues | `POST /v1/consent/entry-qr` | signal + consent |
| Backfill menu affinities from POS | `POST /v1/ops/pos-backfill` | evidence → affinity |
| Solve cold-start with crew blend | `GET /v1/guests/:id/recommendations` | affinity (cold-start) |
| Shift spend to taste-segments | `GET /v1/audiences/taste-segments` | segment |
| Time offers to arena shows | `GET /v1/offers/event-timed` | offer (timing) |
| Launch midweek taste-matched menus | `GET /v1/revenue/midweek-menu` | offer |
| Scale bottle-service attach prompts | `GET /v1/revenue/attach-prompts` | offer |
| Trigger lapsed-VIP win-back | `POST /v1/winback/trigger` | offer (reactivation) |
| Expand crew re-booking nudges | `POST /v1/nudges/crew-rebook` | offer (group) |
| Templatize crew group offers | `GET /v1/crews/:id/group-offer` | offer (group) |
| Coverage-gap / consent audit | `GET /v1/insights/coverage-gap`, `/v1/consent/audit` | measure |

## Non-negotiables (what made it work)

- **Consent gates reachability, not interest.** We can *know* a guest's taste from
  any evidence, but we may only *reach* them where an active `ConsentGrant`
  permits. Audience-building filters on consent; the taste graph does not.
- **Identity-match before spend.** Personalization only lifts spend for guests we
  can resolve. Provisional (un-enriched) guests are the coverage gap; close it at
  the door (walk-in / entry-QR) before expecting uplift.
- **Timing is the multiplier.** The same offer to the same segment converts far
  better bound to a moment — an aligned event, a soft midweek night, a booking
  in-flow, a lapse threshold crossed. Every offer endpoint takes a moment, not
  just a segment.
- **Money is integer cents, always.** No float money anywhere in the loop.
- **Everything idempotent + tenant-scoped.** Sends dedupe per (guest, day); reads
  never cross tenants except the sanctioned consented projection.

## Reuse checklist

When adding a new personalization lever, answer these — if you can't, it isn't
ready:

1. What **signal** does it consume or produce, and with what provenance?
2. Which **affinity subjects** does it read, and are they consent-gated?
3. What is the **segment** (who is addressable), and is reachability enforced?
4. What is the **moment** that times the offer?
5. How is the **outcome** measured back to revenue, and does it feed new signal?
6. Is it **idempotent, tenant-scoped, integer-cents**, and does it avoid marketing
   a take-rate to venues (⚑ placeholder only)?
