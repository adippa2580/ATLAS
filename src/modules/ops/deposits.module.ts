import {
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';
import { StripeAdapter } from '../../integrations/stripe.adapter';
import {
  NoShowFeatures,
  depositTier,
  riskScore,
} from '../../insights/ops/ops-insights.module';

/** Deposit policy decision for a single booking. */
export interface DepositQuote {
  bookingId: string;
  guestId: string;
  requiredDepositCents: number;
  baseDepositCents: number;
  minSpendCents: number;
  riskScore: number;
  tier: 'waive' | 'standard' | 'full';
  policy: 'softened' | 'standard' | 'backed-hold';
  identityMatched: boolean;
  provisional: boolean;
  reason: string;
  factors: {
    trustNet: number;
    priorCancelled: number;
    leadTimeHours: number;
    partySize: number;
  };
}

/**
 * Deposits & Minimums (#11) — a capability inside Booking. Resolves the
 * deposit / minimum from the booked inventory and holds it as a Stripe
 * PaymentIntent before doors.
 *
 * The deposit amount is not static: a risk-based policy softens it for known,
 * low-risk guests (the "soften deposit for known guests" lever) and requires a
 * deposit-backed hold for unverified or no-show-prone bookings (the
 * "deposit-backed holds" yield lever), reusing the grounded no-show risk model.
 */
@Injectable()
export class DepositsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeAdapter,
  ) {}

  /**
   * Compute the deposit policy for a booking WITHOUT charging. Softens for
   * identity-matched low-risk guests; requires a deposit-backed hold for
   * provisional identities or high no-show risk; otherwise standard.
   */
  async quote(ctx: TenantContext, bookingId: string): Promise<DepositQuote> {
    const t = ctx.tenantId;
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, tenantId: t },
      include: {
        inventory: { select: { deposit: true, minSpend: true } },
        guest: { select: { provisional: true } },
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    const [trustEvents, cancelledGroups] = await Promise.all([
      this.prisma.trustEvent.findMany({
        where: { tenantId: t, guestId: booking.guestId },
        select: { kind: true, weight: true },
      }),
      this.prisma.booking.groupBy({
        by: ['guestId'],
        where: { tenantId: t, guestId: booking.guestId, status: 'cancelled' },
        _count: { _all: true },
      }),
    ]);

    // Signed trust: a no_show erodes trust; everything else builds it.
    const trustNet = trustEvents.reduce(
      (acc, e) =>
        acc + (e.kind === 'no_show' ? -Math.abs(e.weight) : Math.abs(e.weight)),
      0,
    );
    const priorCancelled = cancelledGroups[0]?._count._all ?? 0;
    const leadTimeHours =
      (booking.date.getTime() - booking.createdAt.getTime()) / (60 * 60 * 1000);
    const base = booking.inventory?.deposit ?? 0;
    const minSpend = booking.inventory?.minSpend ?? 0;
    const provisional = booking.guest?.provisional ?? true;

    const features: NoShowFeatures = {
      trustNet,
      priorCancelled,
      leadTimeHours,
      hasDeposit: base > 0,
      partySize: booking.partySize,
      provisional,
    };
    const score = riskScore(features);
    const identityMatched = !provisional;

    let requiredDepositCents: number;
    let policy: DepositQuote['policy'];
    let reason: string;
    if (identityMatched && score < 35) {
      // Soften for known, low-risk guests: halve an explicit deposit, or waive.
      requiredDepositCents = base > 0 ? Math.round(base / 2) : 0;
      policy = 'softened';
      reason =
        requiredDepositCents === 0
          ? 'known guest, low no-show risk — deposit waived'
          : 'known guest, low no-show risk — deposit halved';
    } else if (provisional || score > 65) {
      // Deposit-backed hold for unverified or high-risk bookings. When no
      // explicit deposit is configured, floor it at 20% of the minimum spend.
      requiredDepositCents = base > 0 ? base : Math.round(minSpend * 0.2);
      policy = 'backed-hold';
      reason = provisional
        ? 'unverified identity — deposit-backed hold required'
        : 'elevated no-show risk — deposit-backed hold required';
    } else {
      requiredDepositCents = base;
      policy = 'standard';
      reason = 'standard deposit from inventory';
    }

    return {
      bookingId,
      guestId: booking.guestId,
      requiredDepositCents,
      baseDepositCents: base,
      minSpendCents: minSpend,
      riskScore: score,
      tier: depositTier(score),
      policy,
      identityMatched,
      provisional,
      reason,
      factors: {
        trustNet,
        priorCancelled,
        leadTimeHours: Math.round(leadTimeHours * 10) / 10,
        partySize: booking.partySize,
      },
    };
  }

  async hold(ctx: TenantContext, bookingId: string) {
    // The policy decides the amount (softened / standard / deposit-backed).
    const quote = await this.quote(ctx, bookingId);
    const amount = quote.requiredDepositCents;
    const idempotencyKey = `deposit_${bookingId}`;
    const pi = await this.stripe.createPaymentIntent(amount, idempotencyKey);

    return this.prisma.payment.create({
      data: {
        tenantId: ctx.tenantId,
        bookingId,
        stripePiId: pi.id,
        amount,
        payerGuestId: quote.guestId,
        status: pi.status,
        idempotencyKey,
      },
    });
  }
}

@ApiTags('ops:deposits')
@Controller('bookings')
export class DepositsController {
  constructor(private readonly svc: DepositsService) {}

  /** Preview the risk-based deposit policy for a booking without charging. */
  @Get(':id/deposit/quote')
  @Scopes('ops:deposits:read')
  quote(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.svc.quote(ctx, id);
  }

  @Post(':id/deposit')
  @Scopes('ops:deposits:write')
  hold(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.svc.hold(ctx, id);
  }
}

@Module({
  controllers: [DepositsController],
  providers: [DepositsService],
  exports: [DepositsService],
})
export class DepositsModule {}
