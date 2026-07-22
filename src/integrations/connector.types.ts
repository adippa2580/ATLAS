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
 * (Eventbrite, Google Calendar, …). Feeds latent-demand insights, not bookings.
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
