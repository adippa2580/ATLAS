import {
  Controller,
  Get,
  Headers,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  RawBody,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma, Provenance, Signal, SubjectType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EvidenceBus } from '../../common/evidence/evidence-bus';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';
import { evidenceDedupeKey } from '../../common/util/hash';
import { SquareAdapter } from '../../integrations/square.adapter';
import type { TabPayload } from '../../integrations/square.adapter';
import {
  LIGHTSPEED_SIGNATURE_HEADER,
  LightspeedAdapter,
} from '../../integrations/lightspeed.adapter';

/**
 * Normalize a raw POS line-item name into a coarse SKU/category key so that
 * spend can be fanned into the taste graph at product grain (§4.2, insight H).
 * Lowercases, maps obvious keywords, and returns a `product:<category>`
 * subjectRef. Ordering matters — the first matching bucket wins.
 */
export function categorizeSku(name: string): string {
  const n = (name ?? '').toLowerCase();
  const has = (...kws: string[]) => kws.some((k) => n.includes(k));

  let category: string;
  if (has('champagne', 'prosecco')) category = 'champagne';
  else if (has('tequila', 'mezcal')) category = 'tequila';
  else if (has('vodka', 'gin', 'whisk', 'rum')) category = 'spirit';
  else if (has('wine')) category = 'wine';
  else if (has('beer')) category = 'beer';
  else if (has('espresso', 'cocktail', 'martini')) category = 'cocktail';
  else if (has('water', 'soda', 'na')) category = 'na';
  else category = 'other';

  return `product:${category}`;
}

/**
 * Tab / POS Sync (#13) — the Square POS webhook closes the loop from booking →
 * spend → CRM. Each line item on the tab becomes a `spend` signal (provenance
 * `pos`) against the venue AND, per §4.2, against a normalized product/SKU
 * category in the guest's taste graph.
 */
@Injectable()
export class TabService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EvidenceBus,
    private readonly square: SquareAdapter,
    private readonly lightspeed: LightspeedAdapter,
  ) {}

  /**
   * Signed Square webhook. Authenticated by the Square signature over the RAW
   * body (no scope); the tenant is resolved from the referenced booking rather
   * than a token. Spend is recorded in integer minor units (cents).
   */
  async handleWebhook(
    rawBody: Buffer | undefined,
    signature?: string,
    notificationUrl?: string,
  ) {
    if (!this.square.verifyWebhook(rawBody, signature, notificationUrl)) {
      return { received: false };
    }
    return this.ingestVerifiedTab(rawBody, (payload) =>
      this.square.normalizeTab(payload),
    );
  }

  /**
   * Signed Lightspeed (K-Series) webhook — same tab pipeline as Square.
   * Authenticated by the X-Kounta-Signature HMAC over the RAW body; the
   * tenant is resolved from the referenced booking.
   */
  async handleLightspeedWebhook(
    rawBody: Buffer | undefined,
    signature?: string,
  ) {
    if (!this.lightspeed.verifyWebhook(rawBody, signature)) {
      return { received: false };
    }
    return this.ingestVerifiedTab(rawBody, (payload) =>
      this.lightspeed.normalizeTab(payload),
    );
  }

  /** POS-agnostic tab ingest: parse verified bytes, upsert, publish spend. */
  private async ingestVerifiedTab(
    rawBody: Buffer | undefined,
    normalize: (payload: any) => TabPayload,
  ) {
    // Act on exactly the verified bytes.
    let payload: any;
    try {
      payload = rawBody ? JSON.parse(rawBody.toString('utf8')) : undefined;
    } catch {
      return { received: false };
    }
    if (!payload) return { received: true, matched: 0 };

    const bookingId: string | undefined =
      payload?.bookingId ?? payload?.reference ?? payload?.referenceId;
    if (!bookingId) return { received: true, matched: 0 };

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) return { received: true, matched: 0 };

    const tab = normalize(payload);

    await this.prisma.tab.upsert({
      where: { bookingId },
      create: {
        tenantId: booking.tenantId,
        bookingId,
        total: tab.total,
        lineItems: tab.lineItems as unknown as Prisma.InputJsonValue,
        closedAt: tab.closed ? new Date() : null,
      },
      update: {
        total: tab.total,
        lineItems: tab.lineItems as unknown as Prisma.InputJsonValue,
        closedAt: tab.closed ? new Date() : null,
      },
    });

    // Each line item is revealed spend — publish it into the taste graph.
    for (const [i, item] of tab.lineItems.entries()) {
      // Venue-grain spend (unchanged): the whole tab weighs against the venue.
      await this.bus.publish({
        tenantId: booking.tenantId,
        guestId: booking.guestId,
        subjectType: SubjectType.venue,
        subjectRef: booking.venueId,
        signal: Signal.spend,
        weight: Number(item.amount) || 1,
        provenance: Provenance.pos,
        dedupeKey: evidenceDedupeKey(
          'pos',
          `${tab.externalTabId}:${i}`,
          'spend',
        ),
        observedAt: new Date().toISOString(),
      });

      // §4.2 product-grain fan-out: the SAME line ALSO lands as `product`
      // evidence keyed to a normalized SKU/category, so per-SKU taste becomes
      // derived affinity (insight H). The dedupeKey is distinct from the
      // venue-grain key above and unique per booking + line index + category,
      // so at-least-once redelivery never double-counts either grain.
      const productRef = categorizeSku(item.name);
      await this.bus.publish({
        tenantId: booking.tenantId,
        guestId: booking.guestId,
        subjectType: SubjectType.product,
        subjectRef: productRef,
        signal: Signal.spend,
        weight: Number(item.amount) || 1,
        provenance: Provenance.pos,
        dedupeKey: evidenceDedupeKey(
          'pos',
          `product:${bookingId}:${i}:${productRef}`,
          'spend',
        ),
        observedAt: new Date().toISOString(),
      });
    }

    return { received: true, bookingId, lineItems: tab.lineItems.length };
  }

  async get(ctx: TenantContext, bookingId: string) {
    const tab = await this.prisma.tab.findFirst({
      where: { tenantId: ctx.tenantId, bookingId },
    });
    if (!tab) throw new NotFoundException('Tab not found');
    return tab;
  }
}

@ApiTags('ops:tab')
@Controller('webhooks')
export class SquareWebhookController {
  constructor(private readonly svc: TabService) {}

  // No @Scopes — authenticated by Square signature over the raw body, tenant
  // resolved from the referenced booking.
  @Post('square')
  webhook(
    @Req() req: any,
    @RawBody() rawBody: Buffer,
    @Headers('x-square-hmacsha256-signature') signature?: string,
  ) {
    // Square signs over the exact notification URL it POSTed to. Prefer an
    // explicit configured URL; otherwise reconstruct it from the request.
    const notificationUrl =
      process.env.SQUARE_WEBHOOK_URL ??
      `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    return this.svc.handleWebhook(rawBody, signature, notificationUrl);
  }

  // Lightspeed K-Series: X-Kounta-Signature = HMAC-SHA256(rawBody, token),
  // hex (apidoc.kounta.com/webhooks). No scope — signature-authenticated.
  @Post('lightspeed')
  lightspeedWebhook(
    @RawBody() rawBody: Buffer,
    @Headers(LIGHTSPEED_SIGNATURE_HEADER) signature?: string,
  ) {
    return this.svc.handleLightspeedWebhook(rawBody, signature);
  }
}

@ApiTags('ops:tab')
@Controller('bookings')
export class TabController {
  constructor(private readonly svc: TabService) {}

  @Get(':id/tab')
  @Scopes('ops:tab:read')
  get(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.svc.get(ctx, id);
  }
}

@Module({
  controllers: [SquareWebhookController, TabController],
  providers: [TabService],
  exports: [TabService],
})
export class TabModule {}
