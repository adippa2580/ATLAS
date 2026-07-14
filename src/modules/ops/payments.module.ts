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
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsArray, IsNumber, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';
import { StripeAdapter } from '../../integrations/stripe.adapter';
import type { Payment } from '@prisma/client';

class ShareDto {
  @IsString() guestId!: string;
  @IsNumber() amount!: number;
}

class SplitPayDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ShareDto)
  shares!: ShareDto[];
}

/**
 * Split-Pay & Payments (#12) — Stripe rails. Each crew member's share is a
 * separate PaymentIntent under a shared split group, locked before doors. The
 * signed Stripe webhook confirms the intents.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeAdapter,
  ) {}

  async splitPay(ctx: TenantContext, bookingId: string, dto: SplitPayDto) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, tenantId: ctx.tenantId },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    const splitGroupId = randomUUID();
    const payments: Payment[] = [];
    for (const share of dto.shares) {
      const idempotencyKey = `split_${splitGroupId}_${share.guestId}`;
      const pi = await this.stripe.createPaymentIntent(
        share.amount,
        idempotencyKey,
      );
      const payment = await this.prisma.payment.create({
        data: {
          tenantId: ctx.tenantId,
          bookingId,
          stripePiId: pi.id,
          amount: share.amount,
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
   * Signed Stripe webhook. Authenticated by signature (no scope), so the tenant
   * is resolved from the matched Payment rather than a token.
   */
  async handleWebhook(payload: any, signature?: string) {
    if (!this.stripe.verifyWebhook(payload, signature)) {
      return { received: false };
    }
    const piId: string | undefined =
      payload?.data?.object?.id ?? payload?.paymentIntentId ?? payload?.id;
    if (!piId) return { received: true, matched: 0 };

    const result = await this.prisma.payment.updateMany({
      where: { stripePiId: piId },
      data: { status: 'succeeded' },
    });
    return { received: true, matched: result.count };
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

  // No @Scopes — authenticated by Stripe signature, tenant resolved from payload.
  @Post('stripe')
  webhook(
    @Body() payload: any,
    @Headers('stripe-signature') signature?: string,
  ) {
    return this.svc.handleWebhook(payload, signature);
  }
}

@Module({
  controllers: [PaymentsController, StripeWebhookController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
