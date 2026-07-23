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
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';

/**
 * Operator action-outcome ledger — ported from the 2026-07-23 Supabase design
 * spike; MVP subsystems 9–10. Every recommendation surfaced to an operator —
 * whether it came from rules (revenue-prompts, the Event Outlook), a model, an
 * agent, or the operator themselves — becomes a row that moves through
 *
 *   proposed → approved | rejected
 *   approved → executed
 *   executed → measured   (outcome JSON recorded — this closes the loop)
 *
 * The MEASURED outcome is the whole point: it is the training signal that lets
 * "what we suggested" be compared against "what actually happened", per action
 * type, per venue, per source. Illegal transitions are rejected, and the
 * decided/executed/measured timestamps make action latency measurable.
 */
const ACTION_SOURCES = ['rules', 'model', 'operator', 'agent'] as const;
type ActionSource = (typeof ACTION_SOURCES)[number];

type ActionStatus =
  'proposed' | 'approved' | 'rejected' | 'executed' | 'measured';

/** Legal transitions of the action lifecycle. */
const LEGAL: Record<ActionStatus, ActionStatus[]> = {
  proposed: ['approved', 'rejected'],
  approved: ['executed'],
  rejected: [],
  executed: ['measured'],
  measured: [],
};

class ProposeActionDto {
  @IsString() actionType!: string;
  @IsOptional() @IsString() venueId?: string;
  @IsOptional() @IsObject() target?: Record<string, any>;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsObject() expectedImpact?: Record<string, any>;
  @IsOptional() @IsNumber() @Min(0) @Max(1) confidence?: number;
  @IsOptional()
  @IsIn(ACTION_SOURCES as unknown as string[])
  source?: ActionSource;
}

class OutcomeDto {
  @IsObject() outcome!: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
@Injectable()
export class ActionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Record a proposed action (from rules, a model, an agent or an operator). */
  propose(ctx: TenantContext, dto: ProposeActionDto) {
    return this.prisma.operatorAction.create({
      data: {
        tenantId: ctx.tenantId,
        venueId: dto.venueId,
        actionType: dto.actionType,
        target: dto.target,
        reason: dto.reason,
        expectedImpact: dto.expectedImpact,
        confidence: dto.confidence,
        source: dto.source ?? 'rules',
      },
    });
  }

  /** List actions, optionally filtered by status and/or venue. */
  list(ctx: TenantContext, filter: { status?: string; venueId?: string } = {}) {
    return this.prisma.operatorAction.findMany({
      where: {
        tenantId: ctx.tenantId,
        ...(filter.status ? { status: filter.status as ActionStatus } : {}),
        ...(filter.venueId ? { venueId: filter.venueId } : {}),
      },
      orderBy: { proposedAt: 'desc' },
    });
  }

  /** Guarded lifecycle transition with the matching timestamp side-effects. */
  private async transition(
    ctx: TenantContext,
    id: string,
    to: ActionStatus,
    extra: { outcome?: Record<string, any> } = {},
  ) {
    const action = await this.prisma.operatorAction.findFirst({
      where: { id, tenantId: ctx.tenantId },
    });
    if (!action) throw new NotFoundException('Action not found');
    const from = action.status as ActionStatus;
    if (!LEGAL[from].includes(to)) {
      throw new BadRequestException(
        `Illegal action transition ${from} -> ${to}`,
      );
    }
    const now = new Date();
    return this.prisma.operatorAction.update({
      where: { id: action.id },
      data: {
        status: to,
        ...(to === 'approved' || to === 'rejected' ? { decidedAt: now } : {}),
        ...(to === 'executed' ? { executedAt: now } : {}),
        ...(to === 'measured'
          ? { measuredAt: now, outcome: extra.outcome }
          : {}),
      },
    });
  }

  approve(ctx: TenantContext, id: string) {
    return this.transition(ctx, id, 'approved');
  }

  reject(ctx: TenantContext, id: string) {
    return this.transition(ctx, id, 'rejected');
  }

  execute(ctx: TenantContext, id: string) {
    return this.transition(ctx, id, 'executed');
  }

  /** Record the measured outcome — the row that closes the loop. */
  measure(ctx: TenantContext, id: string, dto: OutcomeDto) {
    return this.transition(ctx, id, 'measured', { outcome: dto.outcome });
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------
@ApiTags('ops:actions')
@Controller('actions')
export class ActionsController {
  constructor(private readonly svc: ActionsService) {}

  @Post()
  @Scopes('ops:actions:write')
  propose(@Tenant() ctx: TenantContext, @Body() dto: ProposeActionDto) {
    return this.svc.propose(ctx, dto);
  }

  @Get()
  @Scopes('ops:actions:read')
  list(
    @Tenant() ctx: TenantContext,
    @Query('status') status?: string,
    @Query('venueId') venueId?: string,
  ) {
    return this.svc.list(ctx, { status, venueId });
  }

  @Post(':id/approve')
  @Scopes('ops:actions:write')
  approve(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.svc.approve(ctx, id);
  }

  @Post(':id/reject')
  @Scopes('ops:actions:write')
  reject(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.svc.reject(ctx, id);
  }

  @Post(':id/execute')
  @Scopes('ops:actions:write')
  execute(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.svc.execute(ctx, id);
  }

  @Post(':id/outcome')
  @Scopes('ops:actions:write')
  outcome(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: OutcomeDto,
  ) {
    return this.svc.measure(ctx, id, dto);
  }
}

@Module({
  controllers: [ActionsController],
  providers: [ActionsService],
  exports: [ActionsService],
})
export class ActionsModule {}
