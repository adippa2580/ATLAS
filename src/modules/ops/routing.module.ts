import { Body, Controller, Injectable, Module, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString } from 'class-validator';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';
import { AvailabilityService } from './availability.service';
import { BookingsModule } from './bookings.module';

class RankDto {
  @IsString() venueId!: string;
  @IsOptional() @IsString() crewId?: string;
  @IsOptional() @IsString() guestId?: string;
  @IsOptional() @IsString() date?: string;
  @IsOptional() @IsInt() party?: number;
}

/**
 * Demand Routing (#14) — re-ranks rooms/inventory for the crew (size, blended
 * taste, availability) and routes to the right room. Reuses the same crew-aware
 * heuristic as Bookings availability.
 */
@Injectable()
export class RoutingService {
  constructor(private readonly availability: AvailabilityService) {}

  rank(ctx: TenantContext, dto: RankDto) {
    return this.availability.rank(ctx, dto.venueId, {
      party: dto.party,
      crewId: dto.crewId,
      guestId: dto.guestId,
    });
  }
}

@ApiTags('ops:routing')
@Controller('routing')
export class RoutingController {
  constructor(private readonly svc: RoutingService) {}

  @Post('rank')
  @Scopes('ops:routing:read')
  rank(@Tenant() ctx: TenantContext, @Body() dto: RankDto) {
    return this.svc.rank(ctx, dto);
  }
}

@Module({
  imports: [BookingsModule],
  controllers: [RoutingController],
  providers: [RoutingService],
})
export class RoutingModule {}
