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

/**
 * Tab / POS Sync (#13) — the Square POS webhook closes the loop from booking →
 * spend → CRM. Each line item on the tab becomes a `spend` signal (provenance
 * `pos`) against the venue in the guest's taste graph.
 */
@Injectable()
export class TabService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EvidenceBus,
    private readonly square: SquareAdapter,
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

    const tab = this.square.normalizeTab(payload);

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
