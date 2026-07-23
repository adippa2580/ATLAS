import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
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
import { PrismaService } from '../../common/prisma/prisma.service';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';
import { StripeAdapter } from '../../integrations/stripe.adapter';
import type { Payment } from '@prisma/client';

/**
 * Split-group funding (captain guarantee) — ported from the 2026-07-23
 * Supabase design spike. The FUNDING axis of split-pay, deliberately separate
 * from BookingStatus (floor state): a booking can be seated while still
 * partially funded.
 *
 * The mechanic: the captain authorizes the FULL total up front (the
 * guarantee), each crew member's share is a separate PaymentIntent captured
 * individually, and at the funding deadline the captain's remainder is
 * captured for whatever is still unfunded. The venue is made whole either way
 * — that certainty is what lets a table be committed before doors.
 *
 *   pending → authorized            captain's full-total authorization held
 *   authorized → partially_funded   first crew share captured
 *   partially_funded → funded       captured shares reach the total
 *   {authorized|partially_funded|funded} → settled
 *                                   remainder drawn on the captain (if any)
 *   {pending|authorized} → expired  guarantee released without settlement
 *
 * Every move is logged to SplitGroupEvent (mirrors BookingStatusEvent) so
 * funding TIMING is measured, not inferred. `fundedAmount` is recomputed from
 * captured payments — never incremented blindly — and payments join by
 * splitGroupId VALUE (no FK; pre-existing rows carry ad-hoc group UUIDs).
 */
type FundingState =
  | 'pending'
  | 'authorized'
  | 'partially_funded'
  | 'funded'
  | 'settled'
  | 'expired';

/** Legal transitions of the funding lifecycle. */
const LEGAL: Record<FundingState, FundingState[]> = {
  pending: ['authorized', 'expired'],
  authorized: ['partially_funded', 'funded', 'settled', 'expired'],
  partially_funded: ['funded', 'settled'],
  funded: ['settled'],
  settled: [],
  expired: [],
};

class SplitShareDto {
  @IsString() guestId!: string;
  // Money is integer minor units (cents). Optional so the total can be split
  // evenly across the listed guests instead of specifying each amount.
  @IsOptional() @IsInt() amount?: number;
}

class CreateSplitGroupDto {
  @IsString() captainGuestId!: string;
  // The full booking total (integer cents) the captain guarantees.
  @IsInt() total!: number;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SplitShareDto)
  shares!: SplitShareDto[];
  // ISO timestamp after which settle() may draw the captain's remainder.
  @IsOptional() @IsString() fundingDeadlineAt?: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
@Injectable()
export class SplitGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeAdapter,
  ) {}

  /**
   * Split a total (integer cents) into `n` integer shares that sum EXACTLY to
   * the total — base share `floor(total / n)`, leftover cents handed out
   * one-per-share to the first `remainder` shares (mirrors PaymentsService).
   */
  static splitEvenCents(total: number, n: number): number[] {
    if (n <= 0) return [];
    const base = Math.floor(total / n);
    const remainder = total - base * n;
    return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
  }

  /** Guarded funding-state transition, logged to the SplitGroupEvent ledger. */
  private async transition(
    tenantId: string,
    splitGroupId: string,
    from: FundingState,
    to: FundingState,
    reason?: string,
  ) {
    if (!LEGAL[from].includes(to)) {
      throw new BadRequestException(
        `Illegal funding transition ${from} -> ${to}`,
      );
    }
    await this.prisma.splitGroup.update({
      where: { id: splitGroupId },
      data: { state: to },
    });
    await this.prisma.splitGroupEvent.create({
      data: { tenantId, splitGroupId, fromState: from, toState: to, reason },
    });
  }

  /**
   * Create a captain-guaranteed split group for a booking: hold the captain's
   * full-total authorization, then create each crew member's share PI.
   */
  async createCaptainGuarantee(
    ctx: TenantContext,
    bookingId: string,
    dto: CreateSplitGroupDto,
  ) {
    const t = ctx.tenantId;
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, tenantId: t },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    const group = await this.prisma.splitGroup.create({
      data: {
        tenantId: t,
        bookingId,
        captainGuestId: dto.captainGuestId,
        totalAmount: dto.total,
        fundingDeadlineAt: dto.fundingDeadlineAt
          ? new Date(dto.fundingDeadlineAt)
          : null,
      },
    });
    await this.prisma.splitGroupEvent.create({
      data: {
        tenantId: t,
        splitGroupId: group.id,
        fromState: null,
        toState: 'pending',
        reason: 'created',
      },
    });

    // The guarantee: authorize the captain for the FULL total.
    const captainKey = `sg_${group.id}_captain_auth`;
    const captainPi = await this.stripe.createPaymentIntent(
      dto.total,
      captainKey,
    );
    await this.prisma.payment.create({
      data: {
        tenantId: t,
        bookingId,
        stripePiId: captainPi.id,
        amount: dto.total,
        kind: 'captain_authorization',
        splitGroupId: group.id,
        payerGuestId: dto.captainGuestId,
        status: captainPi.status,
        idempotencyKey: captainKey,
      },
    });
    await this.prisma.splitGroup.update({
      where: { id: group.id },
      data: { captainPiId: captainPi.id },
    });
    await this.transition(
      t,
      group.id,
      'pending',
      'authorized',
      'captain full-total authorization held',
    );

    // Each crew member's share is its own PaymentIntent under the group.
    const amounts = SplitGroupsService.splitEvenCents(
      dto.total,
      dto.shares.length,
    );
    const payments: Payment[] = [];
    for (const [i, share] of dto.shares.entries()) {
      const amount = share.amount ?? amounts[i];
      const key = `sg_${group.id}_${share.guestId}`;
      const pi = await this.stripe.createPaymentIntent(amount, key);
      payments.push(
        await this.prisma.payment.create({
          data: {
            tenantId: t,
            bookingId,
            stripePiId: pi.id,
            amount,
            kind: 'crew_share',
            splitGroupId: group.id,
            payerGuestId: share.guestId,
            status: pi.status,
            idempotencyKey: key,
          },
        }),
      );
    }

    return {
      splitGroupId: group.id,
      state: 'authorized' as FundingState,
      totalAmount: dto.total,
      captainPiId: captainPi.id,
      payments,
    };
  }

  /**
   * Recompute fundedAmount from CAPTURED crew_share / captain_remainder
   * payments and advance the funding state. Tenant is resolved from the group
   * row — this is also the webhook path (see PaymentsService.handleWebhook).
   */
  async refreshFunding(splitGroupId: string) {
    const group = await this.prisma.splitGroup.findUnique({
      where: { id: splitGroupId },
    });
    if (!group) return null;

    const captured = await this.prisma.payment.findMany({
      where: {
        tenantId: group.tenantId,
        splitGroupId,
        kind: { in: ['crew_share', 'captain_remainder'] },
        status: 'succeeded',
      },
      select: { amount: true },
    });
    const fundedAmount = captured.reduce((s, p) => s + p.amount, 0);
    await this.prisma.splitGroup.update({
      where: { id: splitGroupId },
      data: { fundedAmount },
    });

    let state = group.state as FundingState;
    if (state === 'authorized' || state === 'partially_funded') {
      const next: FundingState =
        fundedAmount >= group.totalAmount
          ? 'funded'
          : fundedAmount > 0
            ? 'partially_funded'
            : state;
      if (next !== state) {
        await this.transition(
          group.tenantId,
          splitGroupId,
          state,
          next,
          `funded ${fundedAmount}/${group.totalAmount} cents`,
        );
        state = next;
      }
    }
    return { splitGroupId, fundedAmount, state };
  }

  /**
   * Settle the group: draw the captain's remainder for whatever is unfunded
   * (the guarantee being called), then mark settled.
   */
  async settle(ctx: TenantContext, splitGroupId: string) {
    const group = await this.prisma.splitGroup.findFirst({
      where: { id: splitGroupId, tenantId: ctx.tenantId },
    });
    if (!group) throw new NotFoundException('Split group not found');

    const refreshed = await this.refreshFunding(splitGroupId);
    const fundedAmount = refreshed?.fundedAmount ?? group.fundedAmount;
    const state = (refreshed?.state ?? group.state) as FundingState;
    const remainder = Math.max(0, group.totalAmount - fundedAmount);

    let remainderPayment: Payment | null = null;
    if (remainder > 0) {
      const key = `sg_${splitGroupId}_captain_remainder`;
      const pi = await this.stripe.createPaymentIntent(remainder, key);
      remainderPayment = await this.prisma.payment.create({
        data: {
          tenantId: group.tenantId,
          bookingId: group.bookingId,
          stripePiId: pi.id,
          amount: remainder,
          kind: 'captain_remainder',
          splitGroupId,
          payerGuestId: group.captainGuestId,
          status: pi.status,
          idempotencyKey: key,
        },
      });
    }

    await this.transition(
      group.tenantId,
      splitGroupId,
      state,
      'settled',
      remainder > 0
        ? `captain remainder ${remainder} cents drawn`
        : 'fully crew-funded, no captain draw',
    );

    return {
      splitGroupId,
      state: 'settled' as FundingState,
      fundedAmount,
      remainderCents: remainder,
      remainderPayment,
    };
  }

  /** Release the guarantee without settlement (hold lapsed / booking died). */
  async expire(ctx: TenantContext, splitGroupId: string) {
    const group = await this.prisma.splitGroup.findFirst({
      where: { id: splitGroupId, tenantId: ctx.tenantId },
    });
    if (!group) throw new NotFoundException('Split group not found');
    await this.transition(
      group.tenantId,
      splitGroupId,
      group.state as FundingState,
      'expired',
      'guarantee released without settlement',
    );
    return { splitGroupId, state: 'expired' as FundingState };
  }

  /** Group + its payments (joined by splitGroupId value) + its event ledger. */
  async get(ctx: TenantContext, splitGroupId: string) {
    const group = await this.prisma.splitGroup.findFirst({
      where: { id: splitGroupId, tenantId: ctx.tenantId },
      include: { events: { orderBy: { at: 'asc' } } },
    });
    if (!group) throw new NotFoundException('Split group not found');
    const payments = await this.prisma.payment.findMany({
      where: { tenantId: ctx.tenantId, splitGroupId },
    });
    return { ...group, payments };
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------
@ApiTags('ops:split-groups')
@Controller()
export class SplitGroupsController {
  constructor(private readonly svc: SplitGroupsService) {}

  /** Create a captain-guaranteed split group for a booking. */
  @Post('bookings/:id/split-groups')
  @Scopes('ops:payments:write')
  create(
    @Tenant() ctx: TenantContext,
    @Param('id') bookingId: string,
    @Body() dto: CreateSplitGroupDto,
  ) {
    return this.svc.createCaptainGuarantee(ctx, bookingId, dto);
  }

  @Get('split-groups/:id')
  @Scopes('ops:payments:read')
  get(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.svc.get(ctx, id);
  }

  /** Draw the captain's remainder (if any) and settle the group. */
  @Post('split-groups/:id/settle')
  @Scopes('ops:payments:write')
  settle(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.svc.settle(ctx, id);
  }

  /** Release the guarantee without settlement. */
  @Post('split-groups/:id/expire')
  @Scopes('ops:payments:write')
  expire(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.svc.expire(ctx, id);
  }
}

@Module({
  controllers: [SplitGroupsController],
  providers: [SplitGroupsService],
  exports: [SplitGroupsService],
})
export class SplitGroupsModule {}
