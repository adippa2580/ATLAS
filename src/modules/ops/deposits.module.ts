import {
  Controller,
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

/**
 * Deposits & Minimums (#11) — a capability inside Booking. Resolves the
 * deposit / minimum from the booked inventory and holds it as a Stripe
 * PaymentIntent before doors.
 */
@Injectable()
export class DepositsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeAdapter,
  ) {}

  async hold(ctx: TenantContext, bookingId: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, tenantId: ctx.tenantId },
      include: { inventory: true },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    // Deposit rule resolves from the inventory: explicit deposit, else min-spend.
    const amount =
      booking.inventory?.deposit ?? booking.inventory?.minSpend ?? 0;
    const idempotencyKey = `deposit_${bookingId}`;
    const pi = await this.stripe.createPaymentIntent(amount, idempotencyKey);

    return this.prisma.payment.create({
      data: {
        tenantId: ctx.tenantId,
        bookingId,
        stripePiId: pi.id,
        amount,
        payerGuestId: booking.guestId,
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
