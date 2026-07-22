import {
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IdentityLinkKind } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';

/** A taste connector we can prompt a guest to link during booking. */
type Connector = 'spotify' | 'instagram';

interface ConnectorSpec {
  connector: Connector;
  /** The consent scope a linked connector records (see ConnectorsService). */
  scope: string;
  /** The verified identity link kind a linked connector produces. */
  linkKind: IdentityLinkKind;
  reason: string;
  /** Deep link the client opens to start the (separate) OAuth flow. */
  deepLink: (guestId: string) => string;
}

/**
 * Ordered strongest-enrichment-first. Spotify leads: listen/follow history is
 * the richest single taste signal, so it is the first connector we suggest.
 */
const CONNECTORS: ConnectorSpec[] = [
  {
    connector: 'spotify',
    scope: 'taste:spotify',
    linkKind: IdentityLinkKind.spotify_id,
    reason:
      'Connect Spotify to personalise your night — your top artists and genres drive table, event and crew recommendations.',
    deepLink: (guestId) => `atlas://connect/spotify?guestId=${guestId}`,
  },
  {
    connector: 'instagram',
    scope: 'taste:instagram',
    linkKind: IdentityLinkKind.instagram_id,
    reason:
      'Connect Instagram so we can tune recommendations to the scenes and artists you follow.',
    deepLink: (guestId) => `atlas://connect/instagram?guestId=${guestId}`,
  },
];

export interface ConnectSuggestion {
  connector: Connector;
  reason: string;
  deepLink: string;
}

/** The prompt payload the booking flow renders to nudge a Spotify connect. */
export interface ConnectPrompt {
  bookingId: string;
  guestId: string;
  /** Connectors the guest has already consented to (any order). */
  alreadyConnected: Connector[];
  /** Connectors to prompt, Spotify first; excludes already-connected ones. */
  suggested: ConnectSuggestion[];
  /** True when there is at least one connector left to prompt. */
  eligible: boolean;
}

/**
 * Prompt Spotify connect at booking (enrichment scale lever). For a booking's
 * guest, compute which taste connectors they have NOT yet consented to and
 * return a prompt payload. This does NOT initiate OAuth — it only decides what
 * to show; the client starts the real flow via the connectors endpoints.
 *
 * A connector counts as "already connected" when the guest has a live (not
 * revoked) ConsentGrant for its `taste:<connector>` scope OR a matching
 * IdentityLink kind (spotify_id / instagram_id) — either is proof the guest has
 * linked it, so we never re-prompt something they already granted.
 */
@Injectable()
export class BookingConnectService {
  constructor(private readonly prisma: PrismaService) {}

  async connectPrompt(
    ctx: TenantContext,
    bookingId: string,
  ): Promise<ConnectPrompt> {
    const t = ctx.tenantId;
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, tenantId: t },
      select: { id: true, guestId: true },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    const guestId = booking.guestId;

    // Both reads are tenant-scoped. Consent is "live" only while not revoked.
    const [grants, links] = await Promise.all([
      this.prisma.consentGrant.findMany({
        where: { tenantId: t, guestId, revokedAt: null },
        select: { scope: true, connector: true },
      }),
      this.prisma.identityLink.findMany({
        where: { tenantId: t, guestId },
        select: { kind: true },
      }),
    ]);

    const grantedScopes = new Set(grants.map((g) => g.scope));
    const grantedConnectors = new Set(
      grants.map((g) => g.connector).filter((c): c is string => !!c),
    );
    const linkedKinds = new Set(links.map((l) => l.kind));

    const alreadyConnected: Connector[] = [];
    const suggested: ConnectSuggestion[] = [];

    for (const spec of CONNECTORS) {
      const connected =
        grantedScopes.has(spec.scope) ||
        grantedConnectors.has(spec.connector) ||
        linkedKinds.has(spec.linkKind);
      if (connected) {
        alreadyConnected.push(spec.connector);
      } else {
        suggested.push({
          connector: spec.connector,
          reason: spec.reason,
          deepLink: spec.deepLink(guestId),
        });
      }
    }

    return {
      bookingId: booking.id,
      guestId,
      alreadyConnected,
      suggested,
      eligible: suggested.length > 0,
    };
  }
}

@ApiTags('ops:bookings')
@Controller('bookings')
export class BookingConnectController {
  constructor(private readonly svc: BookingConnectService) {}

  /**
   * Compute the taste-connector prompt for a booking's guest (Spotify first).
   * Read-only: it does not start OAuth, only decides what to prompt.
   */
  @Get(':id/connect-prompt')
  @Scopes('ops:bookings:read')
  connectPrompt(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.svc.connectPrompt(ctx, id);
  }
}

@Module({
  controllers: [BookingConnectController],
  providers: [BookingConnectService],
  exports: [BookingConnectService],
})
export class BookingConnectModule {}
