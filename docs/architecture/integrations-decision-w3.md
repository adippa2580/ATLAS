# W3 — First Five Integrations (decision)

**Status:** Confirmed v1 (Jul-17 target) — the §5 Q2 slate is **confirmed, not replaced**
**Owner:** Adrian + Jack
**Maps to:** Project Plan Q2, Q4, §8 (W3); `primitive-api-spec.md` (#3 Connectors, #12/#13 payments/tab), `integration-loops-w4.md`.
**Purpose:** lock the first five integrations and sequence them into the Phase 01/02 marketplace build.

---

## 1. Decision

The five are **confirmed as proposed**:

| # | Integration | Category | Primitive it writes through | What only it provides |
|---|---|---|---|---|
| 1 | **Stripe** | Payments | Split-Pay & Payments (#12) | Payment + split-pay rails + payouts; card-fingerprint for identity merge |
| 2 | **Spotify** | Taste | Taste Connectors (#3) → Evidence (#4) | Highest-signal taste connector; artist depth/obsession; anchors onboarding |
| 3 | **Instagram** | Taste + attribution | Taste Connectors (#3) + Attribution (#20) | Scenes/venues/people; closes the IG-ad → signup → booking loop |
| 4 | **Klaviyo** | CRM / delivery | Lifecycle / CRM (#19) | Email/CRM rail; makes the venue's existing marketing stack smarter |
| 5 | **Square** | POS / spend | Tab / POS Sync (#13) | Spend data into the guest profile; closes booking → spend → CRM |

**Fifth-slot note:** Square is confirmed as the default POS. **Lightspeed remains the sanctioned fallback** *only if the first anchor venue's stack skews that way* (plan Q2) — the Tab/POS primitive (#13) is POS-agnostic, so swapping the connector does not change the contract. **SoundCloud / Apple Music** stay Phase 02 taste additions.

---

## 2. Why these five (coverage test)

Each maps to a visible step in the booking flow and to the integration loops (W4):

- **Reach** → Instagram (attribution link, the "Book on A-List" entry point)
- **Taste** → Spotify (+ Instagram) — the affinity that makes discovery non-random
- **Book & pay** → Stripe (hold, deposit, split-pay before doors)
- **Spend** → Square (POS tab joins the profile — ground truth)
- **Return** → Klaviyo (discovery delivery, never a blast)

Together they close the full loop *Instagram ad → Spotify taste → Stripe booking → Square spend → Klaviyo winback* (W4 Loop 1) — the canonical "where does the intelligence come from" proof. **Nothing in the first five is redundant**, and no earlier link is missing.

---

## 3. Consent & evidence posture (per data contract)

| Integration | Consent basis | Evidence emitted | Provenance tag |
|---|---|---|---|
| Stripe | Checkout terms | — (payment; card-fingerprint used for merge only) | — |
| Spotify | Connector OAuth | affinity (artists/genres, depth) | `connector` |
| Instagram | Connector OAuth | affinity (scenes/venues/people) | `connector` |
| Klaviyo | Tenant DPA | — (delivery rail; conversion feeds Attribution) | — |
| Square | Tenant DPA | spend (tab/line items) | `pos` |

Every taste write goes through `POST /v1/evidence` with a `consent_grant_id`; no connector writes the graph directly (data-contract §3).

---

## 4. Build sequence (into the marketplace)

Ordered by **critical-path dependency** for the Alpha booking loop, not by ease.

| Order | Integration | Phase | Why this slot | Unblocks |
|---|---|---|---|---|
| 1 | **Stripe** | 01 (Alpha) | The booking loop is worthless without pay + split-pay; also the identity-merge corroborator | Book & Pay, split-pay, identity |
| 2 | **Spotify** | 01 (Alpha) | Onboarding anchor; without taste, recs are random and the app has no standalone value | Onboarding, discovery, crew blend |
| 3 | **Square** | 01 (Alpha) | Closes booking → spend; ground-truth evidence the venue trusts | WRAP, guest intelligence, BI |
| 4 | **Instagram** | 02 (Beta) | Reach/attribution + second taste connector; earned at a moment of value, not at signup (Q4) | Attribution loop, richer affinity |
| 5 | **Klaviyo** | 02 (Beta) | Delivery rail for winback once there's a cohort worth reaching | Audience Studio → campaigns, winback |

**Rationale:** Phase 01 Alpha needs the *money + taste + spend* spine (Stripe, Spotify, Square) to prove the booking-and-intelligence loop on primitives. Instagram and Klaviyo layer on in Phase 02 (closed beta) when there are venues to attribute and cohorts to reach — matching the roadmap and the progressive-onboarding rule (never a wall of four OAuth screens).

---

## 5. Connector framework requirements (common to all five)

So each connector is a thin adapter, not a bespoke pipeline (moat requirement, data-contract §2):

- **OAuth + webhook plumbing** via the Taste Connectors primitive (#3): `authorize` → `callback` → scheduled sync; signed inbound `webhooks/{provider}`.
- **Normalise → evidence:** every connector's output funnels to `POST /v1/evidence` (taste) or the relevant Ops primitive (Stripe #12, Square #13); none writes the graph directly.
- **Idempotency:** `dedupe_key = sha(connector, external_id, signal)` makes re-delivery harmless.
- **Signature verification + replay-safety** on all inbound webhooks (Stripe, Square, Klaviyo).
- **Per-connector consent grant** recorded before the first sync.

Adding integration #6+ later = another adapter on this framework, never new infrastructure.

---

## 6. Confirmed decisions & remaining validation

- ✅ **Confirmed:** Stripe, Spotify, Instagram, Klaviyo, Square as the first five.
- ✅ **Confirmed:** build order — Stripe → Spotify → Square (Phase 01), Instagram → Klaviyo (Phase 02).
- ✅ **Shipped:** SoundCloud + Apple Music taste connectors (Phase-02 additions) — adapters normalise to the same `TasteSignal` shape as Spotify and route through the shared `authorize → callback → consent → evidence` path. Both run in STUB mode until their credentials are set (`SOUNDCLOUD_CLIENT_ID`/`SOUNDCLOUD_CLIENT_SECRET`/`SOUNDCLOUD_REDIRECT_URL`; `APPLE_MUSIC_DEVELOPER_TOKEN`). SoundCloud is a standard OAuth2 auth-code flow; Apple Music authorizes client-side via MusicKit and hands back a Music User Token (no server-side code exchange).
- ⏳ **Validate at anchor:** Square vs Lightspeed against the first anchor venue's actual POS (does not change the #13 contract).
- ⏳ **Confirm:** Instagram API access tier / scopes sufficient for the affinity + attribution we need (biggest external-dependency risk of the five).

---

## 7. Klaviyo live delivery — the metric/flow contract

Atlas delivers through Klaviyo's **server-side Events API**, not its Campaigns
API. For each consented recipient it pushes a single metric **event**; the
venue's own Klaviyo **flows** subscribe to that metric and send the actual
message. Atlas never creates or sends a campaign to a list — delivery is
*discovery, never a blast*, and the marketer keeps control of copy, timing,
and suppression (prop 4: makes the existing stack smarter, no rip-and-replace).

**This means the metric names below are the integration contract.** During
Klaviyo setup the venue creates **one flow per metric it wants live**, each
triggered by that metric. A metric with no flow simply does nothing — safe by
default, opt-in per message type.

| Klaviyo metric (create a flow on this) | Fired by | When | Key event properties |
|---|---|---|---|
| **Atlas Event Match** | Recommendations → *Promote to matched guests* | Operator promotes a dated event to its taste-matched, consented audience | `event`, `date`, `audienceId`, `guestName` |
| **Atlas Regulars Lock-In** | Recommendations → *Lock in regulars* | A flagged competitor is opening; defend exposed regulars | `rival`, `audienceId`, `guestName` |
| **Atlas Winback** | `POST /v1/winback/trigger` | A lapsed VIP crosses the lapse threshold | `lapseDays`, `topAffinity`, `message`, `guestName` |
| **Atlas Crew Rebook** | `POST /v1/nudges/crew-rebook` | A crew with a past visit and nothing upcoming goes quiet | `crewId`, `lastVisit`, `sinceDays`, `message`, `guestName` |
| **Atlas Loyalty Claim** | Booking closeout | A still-provisional venue-link guest earned credit (phone-keyed) | `venue`, `message` |
| **Atlas Campaign** | `POST /v1/campaigns` (lifecycle) | Generic audience push over an audience's matched-guest set | `campaignId`, `audienceId`, `guestName` |

Any future template with no mapping falls back to the metric **Atlas Signal**,
so an unmapped send is still visible in Klaviyo rather than silently dropped.

**Profile resolution.** Each event carries a `profile` keyed by the guest's
`email`, `phone_number` (E.164), and `external_id` (the Atlas guestId). A venue
that syncs its own profiles by `external_id` resolves the person even without a
matching email/phone on file.

**Going live.** Set the `KLAVIYO_API_KEY` repo secret (a Klaviyo **private**
API key) — the next deploy flips the adapter from stub → live automatically.
Unset, the rail stays in STUB mode (logs intent, reports `stub: true`), so this
is safe to ship ahead of the key. Delivery is **fail-soft**: a Klaviyo outage
or a recipient with no contact key is counted as `skipped`, never surfaced as
an error on the action that triggered it.

---

## 8. Music taste connectors — the 2026 API reality (verified)

Three-platform research (2026) settled what is actually buildable. Summary so
nobody re-litigates it:

| Platform | Taste reads | Blend API | Concerts API | Production at guest scale? |
|---|---|---|---|---|
| **Apple Music** | ✅ heavy-rotation + library artists | ❌ none | ❌ none | ✅ **yes** — no user cap (rate-limited) |
| **Spotify** | ✅ top artists/tracks, followed artists | ❌ none | ❌ none | ⚠️ **pilot only** (see cap) |
| **SoundCloud** | ✅ followings + free-text genres | ❌ none | ❌ none | ⚠️ paywalled + PKCE + commercial-use limits |

**Blend and concerts are NOT exposed by any of these APIs.** Spotify's/Apple's
in-app concerts are fed by Ticketmaster/Bandsintown; Blend is a Spotify-only
consumer feature with no API surface. Both are therefore **native ATLAS builds**:
- **Blend** → computed from our own taste graph (venue crowd-blend, guest-to-guest,
  crew-blend) reusing the crew consensus-boost math. No third-party dependency.
- **Concerts** → extend the existing Ticketmaster (`eventsfeed`) integration with
  the attractions→attractionId→events path, joined to guests' followed/affinity
  artists ("artists your guests follow are playing near you"); Bandsintown a
  future complement for long-tail acts.

**Apple Music** is the production taste source: server-minted ES256 developer
token (Team ID + Key ID + .p8) + a MusicKit browser handshake for the per-user
Music User Token. No user cap.

**Spotify hard cap (Feb 2026):** dev-mode apps are limited to **5 authenticated
users**, the owner must be **Premium**, and Extended Access now requires a
**registered business with ≥250k MAU** — effectively unreachable for a venue
platform. Treat Spotify as a **≤5-guest pilot** connector, not production. Taste
reads used: `/me/top/artists` + `/me/following?type=artist` (scopes
`user-top-read user-follow-read`). Note: artist `genres` is sparse post-Feb-2026,
so genre signal from Spotify is best-effort.

**SoundCloud** stays STUB by choice: going live needs a paid Artist-Pro app,
OAuth 2.1 **PKCE** (our adapter is auth-code without PKCE), JWT-sized token
storage, and its terms restrict commercial use — low ROI versus Apple Music.
