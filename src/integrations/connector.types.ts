/**
 * Shared payload shapes for connector adapters, so every reservation and
 * demand connector normalises to one platform-internal contract regardless of
 * vendor. POS adapters use `TabPayload` from square.adapter; these cover the
 * two other connector categories.
 */

/**
 * A reservation ingested from an external booking system (SevenRooms, Resy,
 * Tock, …), normalised to the fields the Booking primitive needs. Money is
 * integer minor units (cents).
 */
export interface ReservationPayload {
  /** Vendor's reservation id — the idempotency anchor. */
  externalReservationId: string;
  guestName?: string;
  guestPhone?: string; // E.164
  guestEmail?: string;
  partySize: number;
  /** Reservation date/time, ISO 8601. */
  date: string;
  /** External table/area reference, if the vendor assigns one. */
  tableRef?: string;
  status: 'booked' | 'seated' | 'cancelled' | 'no_show';
  /** Optional per-reservation minimum spend, integer cents. */
  minSpendCents?: number;
}

/**
 * A demand/event signal ingested from a ticketing or calendar connector
 * (Eventbrite, Google Calendar, DICE, Resident Advisor, POSH, Fourvenues …).
 * Feeds latent-demand insights, not bookings.
 */
export interface DemandSignal {
  /** Vendor's event id — the idempotency anchor. */
  externalEventId: string;
  name: string;
  subjectType: 'event' | 'artist' | 'genre';
  subjectRef: string;
  /** Event start, ISO 8601. */
  startsAt?: string;
  /** Relative demand weight (e.g. capacity, sold, RSVP count normalised). */
  demandWeight: number;
  /** Free-text venue/city hint for matching, if provided. */
  venueHint?: string;
}

/**
 * Artist intelligence ingested from a music-data connector (Soundcharts,
 * Chartmetric, Co:Brand …). Enriches an Entity(kind=artist) with streaming,
 * social, geographic and momentum signals so artists can be ranked by audience
 * fit and commercial potential. All metrics are best-effort — any field may be
 * absent when the vendor doesn't provide it. `momentum` is a normalised −1..1
 * trend (rising positive); `fitScore` is a 0..1 blend the connector computes.
 */
export interface ArtistIntel {
  /** Vendor's artist id — the idempotency anchor. */
  externalArtistId: string;
  name: string;
  /** Primary genres, if the vendor classifies. */
  genres?: string[];
  /** Monthly listeners / total followers across platforms, best-effort. */
  monthlyListeners?: number;
  followers?: number;
  /** Normalised recent-growth trend, −1 (falling) … 1 (surging). */
  momentum?: number;
  /** Top audience markets (city or country codes), most-to-least. */
  topMarkets?: string[];
  /** Connector-computed 0..1 audience-fit / commercial-potential blend. */
  fitScore?: number;
  /** Emerging flag — below the mainstream threshold but rising (Co:Brand). */
  emerging?: boolean;
}

/**
 * A secondary-market / resale demand signal (CrowdVolt). Surfaces late demand
 * and price pressure on sold-out events so venues see undersupplied artists.
 * Not inventory to sell — a demand-intelligence signal.
 */
export interface ResaleSignal {
  /** Vendor's listing/event id — the idempotency anchor. */
  externalEventId: string;
  eventName: string;
  subjectRef: string;
  /** Count of active resale listings (relative volume). */
  resaleVolume: number;
  /** Resale price ÷ face value; > 1 means above face (demand pressure). */
  pricePressure: number;
  soldOut: boolean;
  startsAt?: string;
  venueHint?: string;
}

/**
 * Talent-booking execution (GigFinesse). Outbound: a ranked shortlist Atlas
 * sends for a (venue, date) with budget. Inbound: the confirmed engagement that
 * comes back, normalised to what the TalentEngagement primitive needs. Money is
 * integer minor units (cents).
 */
export interface TalentShortlistItem {
  /** Atlas-side artist reference (Entity name or external id). */
  artistRef: string;
  /** Ranking rationale weight, higher = stronger fit. */
  rank: number;
  /** Modeled budget ceiling for this artist, integer cents. */
  budgetCapCents: number;
}

export interface ConfirmedTalentEvent {
  /** Vendor's booking id — the idempotency anchor. */
  externalBookingId: string;
  artistRef: string;
  /** Confirmed performance date, ISO 8601. */
  date: string;
  /** Agreed fee, integer cents. */
  feeCents: number;
  status: 'offered' | 'confirmed' | 'cancelled';
  venueHint?: string;
}
