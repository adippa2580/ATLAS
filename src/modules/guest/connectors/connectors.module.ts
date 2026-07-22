import {
  Body,
  Controller,
  Injectable,
  Module,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
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
  // CSRF: the opaque state nonce issued by /authorize must round-trip back here.
  @IsString() state!: string;
  // Retained for the provider redirect payload; the authoritative guestId is the
  // one bound to the state nonce server-side, not this client-supplied value.
  @IsOptional() @IsString() guestId?: string;
  // NOTE: an access token is intentionally NOT accepted from the client body —
  // the real flow exchanges the provider `code` for a token server-side.
  @IsOptional() @IsString() code?: string;
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

  /**
   * Pending OAuth state nonces → the request that issued them. Guards against
   * CSRF / login-fixation on the callback (P1). In-memory is per-instance and
   * lost on restart — TODO: move to Redis with a short TTL so this survives
   * horizontal scaling and expires abandoned flows.
   */
  private readonly pendingStates = new Map<
    string,
    { provider: string; guestId: string; createdAt: number }
  >();

  authorize(provider: string, dto: AuthorizeDto) {
    // Unpredictable, single-use nonce instead of the guessable `provider:guestId`.
    const state = randomBytes(32).toString('hex');
    this.pendingStates.set(state, {
      provider,
      guestId: dto.guestId,
      createdAt: Date.now(),
    });
    const url =
      provider === 'instagram'
        ? this.instagram.authorizeUrl(state)
        : this.spotify.authorizeUrl(state);
    return { provider, authorizeUrl: url, state };
  }

  /** Complete OAuth → record consent → sync taste into evidence. */
  async callback(ctx: TenantContext, provider: string, dto: CallbackDto) {
    // Validate the CSRF state nonce and bind guestId to the issuing request.
    const pending = this.pendingStates.get(dto.state);
    if (!pending || pending.provider !== provider) {
      throw new UnauthorizedException('Invalid or expired OAuth state');
    }
    this.pendingStates.delete(dto.state); // single-use
    const guestId = pending.guestId;

    // TODO: real server-side code→token exchange belongs here — POST the
    // provider's OAuth `code` (dto.code) to its token endpoint with the client
    // secret and receive the access token. We must NEVER accept an access token
    // from the client body. Until that is wired, adapters run against a stub.
    const accessToken = 'stub';

    const consent = await this.prisma.consentGrant.create({
      data: {
        tenantId: ctx.tenantId,
        guestId,
        scope: `taste:${provider}`,
        basis: ConsentBasis.connector_oauth,
        connector: provider,
      },
    });

    const signals =
      provider === 'instagram'
        ? await this.instagram.fetchTaste(accessToken)
        : await this.spotify.fetchTaste(accessToken);

    for (const s of signals) {
      await this.taste.appendEvidence(ctx, {
        guestId,
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
