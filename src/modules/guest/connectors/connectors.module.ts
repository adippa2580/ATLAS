import {
  Body,
  Controller,
  Injectable,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';
import { TasteModule } from '../taste/taste.module';
import { TasteService } from '../taste/taste.service';
import { SpotifyAdapter } from '../../../integrations/spotify.adapter';
import { InstagramAdapter } from '../../../integrations/instagram.adapter';
import { evidenceDedupeKey } from '../../../common/util/hash';
import { ConsentBasis } from '@prisma/client';

class AuthorizeDto {
  @IsString() guestId!: string;
}
class CallbackDto {
  @IsString() guestId!: string;
  @IsOptional() @IsString() accessToken?: string;
}
class QuizDto {
  @IsString() guestId!: string;
  @IsArray() @IsString({ each: true }) genres!: string[];
}

/**
 * Taste Connectors (#3) — OAuth + quiz fallback. Every connector normalises to
 * evidence via TasteService; none writes the graph directly. Progressive
 * onboarding: one connector at signup, quiz fallback, earn the rest later.
 */
@Injectable()
export class ConnectorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taste: TasteService,
    private readonly spotify: SpotifyAdapter,
    private readonly instagram: InstagramAdapter,
  ) {}

  authorize(provider: string, dto: AuthorizeDto) {
    const state = `${provider}:${dto.guestId}`;
    const url =
      provider === 'instagram'
        ? this.instagram.authorizeUrl(state)
        : this.spotify.authorizeUrl(state);
    return { provider, authorizeUrl: url, state };
  }

  /** Complete OAuth → record consent → sync taste into evidence. */
  async callback(ctx: TenantContext, provider: string, dto: CallbackDto) {
    const consent = await this.prisma.consentGrant.create({
      data: {
        tenantId: ctx.tenantId,
        guestId: dto.guestId,
        scope: `taste:${provider}`,
        basis: ConsentBasis.connector_oauth,
        connector: provider,
      },
    });

    const signals =
      provider === 'instagram'
        ? await this.instagram.fetchTaste(dto.accessToken ?? 'stub')
        : await this.spotify.fetchTaste(dto.accessToken ?? 'stub');

    for (const s of signals) {
      await this.taste.appendEvidence(ctx, {
        guestId: dto.guestId,
        subjectType: s.subjectType as any,
        subjectRef: s.subjectRef,
        signal:
          s.subjectType === 'artist' ? ('follow' as any) : ('listen' as any),
        weight: s.weight,
        provenance: 'connector' as any,
        consentId: consent.id,
        dedupeKey: evidenceDedupeKey(provider, s.externalId, 'connect'),
      });
    }
    return { provider, synced: signals.length, consentId: consent.id };
  }

  /** 30-second taste quiz — the zero-connector fallback. */
  async quiz(ctx: TenantContext, dto: QuizDto) {
    for (const genre of dto.genres) {
      await this.taste.appendEvidence(ctx, {
        guestId: dto.guestId,
        subjectType: 'genre' as any,
        subjectRef: genre.toLowerCase(),
        signal: 'listen' as any,
        weight: 1,
        provenance: 'connector' as any,
        dedupeKey: evidenceDedupeKey('quiz', dto.guestId, genre),
      });
    }
    return { synced: dto.genres.length };
  }
}

@ApiTags('guest:connectors')
@Controller('connectors')
export class ConnectorsController {
  constructor(private readonly svc: ConnectorsService) {}

  @Post(':provider/authorize')
  @Scopes('guest:connectors:write')
  authorize(@Param('provider') provider: string, @Body() dto: AuthorizeDto) {
    return this.svc.authorize(provider, dto);
  }

  @Post(':provider/callback')
  @Scopes('guest:connectors:write')
  callback(
    @Tenant() ctx: TenantContext,
    @Param('provider') provider: string,
    @Body() dto: CallbackDto,
  ) {
    return this.svc.callback(ctx, provider, dto);
  }

  @Post('quiz')
  @Scopes('guest:connectors:write')
  quiz(@Tenant() ctx: TenantContext, @Body() dto: QuizDto) {
    return this.svc.quiz(ctx, dto);
  }
}

@Module({
  imports: [TasteModule],
  controllers: [ConnectorsController],
  providers: [ConnectorsService],
})
export class ConnectorsModule {}
