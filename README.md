# Atlas

Atlas is the multi-tenant **intelligence-and-booking platform** for hospitality — the substrate that turns everyday guest and venue actions into venue-facing intelligence. It exposes ~23 **primitives** (versioned public APIs) across three hubs — **Guest**, **Ops**, **Marketing** — and every tenant consumes the same public contract.

**A-List** is Atlas's first tenant and first customer: the consumer app for discovering, planning, and booking nightlife. A-List is the *engine* that generates the taste and behavioural data Atlas learns from.

## Documentation

- [`docs/architecture/atlas-system-design.md`](docs/architecture/atlas-system-design.md) — system design (draft v1): requirements, high-level architecture, data model, API contract, taste graph, identity resolution, scale/reliability, trade-offs, and the consent/data-contract model.
- [`docs/architecture/data-contract-alist-atlas.md`](docs/architecture/data-contract-alist-atlas.md) — W1 A-List ↔ Atlas data contract: what lives where, the four ingest classes, what flows / never flows, consent basis, ownership, and identity-join mechanics.
- [`docs/architecture/primitive-api-spec.md`](docs/architecture/primitive-api-spec.md) — the primitive-by-primitive public tenant API contract (23 primitives across Guest/Ops/Marketing), with scopes, evidence emitted, MCP exposure, and MVP staging.
- [`docs/architecture/alist-journey-w2.md`](docs/architecture/alist-journey-w2.md) — W2 screen-level A-List journey mapped onto the primitives (onboarding → PLAN → ADJUST → BOOK & PAY → LIVE → WRAP), including the crew taste-composition (blend) interface and the venue-link (class 1b) variant.

## Status

Phase 00 — journey spec and primitive-contract definition. See the roadmap section of the system design doc.
