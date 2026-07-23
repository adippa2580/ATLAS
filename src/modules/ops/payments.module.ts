import {
  Body,
  Controller,
  Get,
  Headers,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  RawBody,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';
import { StripeAdapter } from '../../integrations/stripe.adapter';
import { SplitGroupsModule, SplitGroupsService } from './split-groups.module';
import type { Payment } from '@prisma/client';

class ShareDto {
  @IsString() guestId!: string;
  // Money is integer minor units (cents). Optional so a `total` can be split
  // evenly across the listed guests instead of specifying each amount.
  @IsOptional() @IsInt() amount?: number;
}

class SplitPayDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ShareDto)
  shares!: ShareDto[];
  // Optional total (integer cents) to divide evenly across `shares`. When set,
  // it takes precedence over any per-share amounts and the shares are
  // guaranteed to sum EXACTLY to this total (deterministic remainder).
  @IsOptional() @IsInt() total?: number;
}

/**
 * Split-Pay & Payments (#12) — Stripe rails. Each crew member's share is a
 * separate PaymentIntent under a shared split group, locked before doors. The
 * signed Stripe webhook confirms the intents. For the captain-guarantee
 * funding lifecycle on top of these rails (full-total captain authorization,
 * partial funding, deadline settlement) see SplitGroupsService — a succeeded
 * payment that belongs to a SplitGroup advances that group's funding state.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeAdapter,
    private readonly splitGroups: SplitGroupsService,
  ) {}

  /**
   * Split a total (integer cents) into `n` integer shares that sum EXACTLY to
   * the total. The base share is `floor(total / n)`; the leftover cents
   * (`total - base * n`) are handed out one-per-share to the first `remainder`
   * shares — deterministic, and never creates or loses a cent.
   */
  private static splitEvenCents(total: number, n: number): number[] {
    if (n <= 0) return [];
    const base = Math.floor(total / n);
    const remainder = total - base * n;
    return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
  }

  async splitPay(ctx: TenantContext, bookingId: string, dto: SplitPayDto) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, tenantId: ctx.tenantId },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    // Resolve each share's amount in integer cents. If a `total` is supplied it
    // is divided evenly with the remainder assigned deterministically; the
    // shares are then guaranteed to sum exactly to `total`. Otherwise the
    // per-share integer amounts are used as-is.
    const amounts =
      dto.total != null
        ? PaymentsService.splitEvenCents(dto.total, dto.shares.length)
        : dto.shares.map((s) => s.amount ?? 0);

    const splitGroupId = randomUUID();
    const payments: Payment[] = [];
    for (const [i, share] of dto.shares.entries()) {
      const amount = amounts[i];
      const idempotencyKey = `split_${splitGroupId}_${share.guestId}`;
      const pi = await this.stripe.createPaymentIntent(amount, idempotencyKey);
      const payment = await this.prisma.payment.create({
        data: {
          tenantId: ctx.tenantId,
          bookingId,
          stripePiId: pi.id,
          amount,
          splitGroupId,
          payerGuestId: share.guestId,
          status: pi.status,
          idempotencyKey,
        },
      });
      payments.push(payment);
    }
    return { splitGroupId, payments };
  }

  list(ctx: TenantContext, bookingId: string) {
    return this.prisma.payment.findMany({
      where: { tenantId: ctx.tenantId, bookingId },
    });
  }

  /**
   * Signed Stripe webhook. Authenticated by the Stripe signature over the RAW
   * body (no scope); the tenant is resolved from the matched Payment rather than
   * a token. Only `payment_intent.succeeded` marks a payment succeeded.
   */
  async handleWebhook(rawBody: Buffer | undefined, signature?: string) {
    if (!this.stripe.verifyWebhook(rawBody, signature)) {
      return { received: false };
    }
    // Act on exactly the verified bytes.
    let event: any;
    try {
      event = rawBody ? JSON.parse(rawBody.toString('utf8')) : undefined;
    } catch {
      return { received: false };
    }
    if (!event) return { received: true, matched: 0 };
    // Verify the event TYPE before mutating anything.
    if (event.type !== 'payment_intent.succeeded') {
      return { received: true, ignored: event.type ?? 'unknown' };
    }
    const piId: string | undefined = event?.data?.object?.id;
    if (!piId) return { received: true, matched: 0 };
    // Look up by the now-unique stripePiId, then update SCOPED to that single
    // record (its own tenantId) — never an unscoped updateMany.
    const payment = await this.prisma.payment.findUnique({
      where: { stripePiId: piId },
    });
    if (!payment) return { received: true, matched: 0 };
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'succeeded' },
    });
    // If the payment belongs to a captain-guarantee split group, recompute the
    // group's fundedAmount and advance its funding state (partially_funded →
    // funded). No-op for legacy ad-hoc split groups with no SplitGroup row.
    let funding: unknown = undefined;
    if (payment.splitGroupId) {
      funding = await this.splitGroups.refreshFunding(payment.splitGroupId);
    }
    return { received: true, matched: 1, tenantId: payment.tenantId, funding };
  }
}

@ApiTags('ops:payments')
@Controller('bookings')
export class PaymentsController {
  constructor(private readonly svc: PaymentsService) {}

  @Post(':id/split-pay')
  @Scopes('ops:payments:write')
  splitPay(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: SplitPayDto,
  ) {
    return this.svc.splitPay(ctx, id, dto);
  }

  @Get(':id/payments')
  @Scopes('ops:payments:read')
  list(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.svc.list(ctx, id);
  }
}

@ApiTags('ops:payments')
@Controller('webhooks')
export class StripeWebhookController {
  constructor(private readonly svc: PaymentsService) {}

  // No @Scopes — authenticated by Stripe signature over the raw body, tenant
  // resolved from the matched Payment.
  @Post('stripe')
  webhook(
    @RawBody() rawBody: Buffer,
    @Headers('stripe-signature') signature?: string,
  ) {
    return this.svc.handleWebhook(rawBody, signature);
  }
}

@Module({
  imports: [SplitGroupsModule],
  controllers: [PaymentsController, StripeWebhookController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
