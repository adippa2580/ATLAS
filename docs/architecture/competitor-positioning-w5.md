# W5 — Competitor Positioning Grid

**Status:** Draft v1 (for the Jul-31 target)
**Owner:** Adrian
**Maps to:** Project Plan §6; deck slide 11 (competitive).
**Purpose:** a **positioning-led** grid — "where we win" — not a feature checklist. The feature-by-feature appendix (§4) is an *internal* tool to prioritise our own integrations, never the sales story.

**Positioning line:** *Fourvenues, Tablelist and SevenRooms help venues **manage the room**. A-List/Atlas helps venues **own demand, understand guests, route taste-driven bookings, and turn culture into repeat revenue.*** Short form: **they manage the room; we connect the room to the guest, the crew, the taste graph, the booking, the spend, the loyalty, and the next visit.**

They prove the market — that's a **tailwind, not a threat**.

---

## 1. The comparison set

| Competitor | Category | Role in our narrative |
|---|---|---|
| **Fourvenues** | Nightlife ops (most serious) | Primary head-to-head — runs the night, stops at the room |
| **Tablelist** | Table booking / ticketing | "Another Tablelist" is the failure mode we must avoid (pitch §"one concern") |
| **SevenRooms** | Reservations / CRM (upscale) | Per-seat CRM; stores reservations, doesn't own demand |
| **Tock / Resy** | Reservations (adjacent) | Adjacents — dining-led, not nightlife/taste |
| **Apaleo** | Hotel PMS w/ open API + MCP | The **agent-readiness** comparison only |

---

## 2. Where we win (the three axes — deck slide 11)

### 2.1 Connect the room to the guest
Fourvenues and Tablelist run the night. **Atlas links room → guest, crew, taste, spend, loyalty — and the next visit.** The others manage a reservation; we own the relationship from discovery to repeat. This is the whole "layer above the CRM" thesis: SevenRooms stores reservations, Stripe stores payments, Spotify stores music — **Atlas connects everything and answers questions no single system can.**

### 2.2 Two-sided MCP, day one
Consumer agents (Claude · ChatGPT · Perplexity) **and** tenant-side agents call the **same** toolkit. **Apaleo's MCP is supply-side only.** Nobody else is agent-ready on the consumer side — this is a structural, not incremental, difference (see `primitive-api-spec.md` MCP columns).

### 2.3 Operator-aligned economics
**Entitlement wallet + rev-share that grows with the operator.** SevenRooms and Apaleo sell software **per seat, per room** — a cost that scales against the operator. Our first dollar is a **booking take-rate** (the venue pays nothing up front), aligning us with the operator's revenue, not their headcount.

---

## 3. The moat they can't copy (deck slide 12)

Apps are copyable; this proof is not:

| Proof | Why it's uncopyable |
|---|---|
| **Taste graph** | Consumer-consented affinity at volume — data Atlas gets from the A-List consumer side that a venue-only tool structurally cannot |
| **Crew behaviour** | How groups decide, blend taste, and spend — attached to real bookings |
| **Booking & loyalty** | Demand routing, split-pay, entitlements exercised in production |
| **Spend data** | POS-joined guest profiles that close the loop |

The competitors are venue-side only, so they have **no consumer write path** — no taste graph. That's why the A-List flagship anchor exists (data-contract §1).

---

## 4. Feature appendix (INTERNAL — prioritisation only)

Legend: ● strong · ◑ partial · ○ none/weak. This drives *our* integration roadmap; it is **not** the sales grid.

| Capability | Fourvenues | Tablelist | SevenRooms | Tock/Resy | **Atlas/A-List** |
|---|---|---|---|---|---|
| Table/ticket booking | ● | ● | ● | ● | ● |
| Consumer discovery app | ◑ | ◑ | ○ | ◑ | ● |
| Taste graph (consented affinity) | ○ | ○ | ○ | ○ | ● |
| Crew as recommendation input | ○ | ○ | ○ | ○ | ● |
| Split-pay | ◑ | ◑ | ○ | ○ | ● |
| Guest CRM / profile | ◑ | ◑ | ● | ◑ | ● |
| POS/spend join | ○ | ○ | ◑ | ○ | ● |
| Audience matching / opportunities | ○ | ○ | ◑ | ○ | ● |
| Cross-venue benchmarks | ○ | ○ | ◑ | ○ | ● |
| Consumer-side agent (MCP) | ○ | ○ | ○ | ○ | ● |
| Tenant-side agent (MCP) | ○ | ○ | ○ | ○ (Apaleo ●) | ● |
| Loyalty across venues | ○ | ○ | ◑ | ○ | ● |
| Rev-share economics | ◑ | ◑ | ○ | ○ | ● |

**Read:** we don't win by having *more* booking features — we win by owning the axes the venue-side tools structurally can't reach (taste, crew, consumer agent, cross-venue intelligence).

---

## 5. Risks / discipline

- **"Another Tablelist" risk** — if the A-List experience is only "make an account and book a table," the consumer gets no value and the loop never starts. Discovery/crew/taste must stand alone (journey §0, pitch §"one concern").
- **Positioning drift** — keep "substrate" language *out* of venue GTM (wedge-first, per W7). Substrate is the closing-slide vision for investors, not the sales lead.
- **Apaleo comparison scope** — only invoke Apaleo for agent-readiness; it's a hotel PMS, not a nightlife competitor.
