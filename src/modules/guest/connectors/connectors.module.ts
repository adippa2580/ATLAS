import {
  Get,
  Query,
  Res,
  Body,
  Controller,
  Injectable,
  Module,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import type { Response as ExpressResponse } from 'express';

/** The A-List flagship tenant — browser OAuth legs write into its graph. */
const FLAGSHIP_TENANT_ID = '00000000-0000-0000-0000-00000000a115';
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
    private readonly config: ConfigService,
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

  /** Invite tokens: HMAC-signed { guestId, exp } — the ONLY way into /connect. */
  private inviteSecret(): string {
    return this.config.get<string>('connectors.connectInviteSecret') ?? '';
  }

  signInvite(guestId: string, ttlSeconds = 900): string {
    const secret = this.inviteSecret();
    const isProd = this.config.get<string>('env') === 'production';
    if (!secret) {
      if (isProd) {
        throw new UnauthorizedException(
          'Connector invites unavailable: no signing secret configured',
        );
      }
      // dev/stub: unsigned marker token, clearly non-production
      return (
        Buffer.from(
          JSON.stringify({
            guestId,
            exp: Math.floor(Date.now() / 1000) + ttlSeconds,
          }),
        ).toString('base64url') + '.dev'
      );
    }
    const body = JSON.stringify({
      guestId,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    });
    const sig = createHmac('sha256', secret).update(body).digest('base64url');
    return Buffer.from(body).toString('base64url') + '.' + sig;
  }

  verifyInvite(token: string): string {
    const [b64, sig] = (token ?? '').split('.');
    if (!b64 || !sig) throw new UnauthorizedException('Malformed invite');
    const body = Buffer.from(b64, 'base64url').toString('utf8');
    const secret = this.inviteSecret();
    const isProd = this.config.get<string>('env') === 'production';
    if (!secret) {
      if (isProd) throw new UnauthorizedException('Invites unavailable');
      // dev/stub path accepts its own marker tokens only
      if (sig !== 'dev') throw new UnauthorizedException('Invalid invite');
    } else {
      const expected = createHmac('sha256', secret)
        .update(body)
        .digest('base64url');
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new UnauthorizedException('Invalid invite signature');
      }
    }
    let data: { guestId?: string; exp?: number };
    try {
      data = JSON.parse(body);
    } catch {
      throw new UnauthorizedException('Malformed invite');
    }
    if (!data.guestId || typeof data.exp !== 'number') {
      throw new UnauthorizedException('Malformed invite');
    }
    if (data.exp < Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException('Invite expired');
    }
    return data.guestId;
  }

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

    // Server-side code→token exchange (never accept tokens from the client).
    // Instagram stays stubbed pending a Meta app review; Spotify is live when
    // SPOTIFY_CLIENT_ID/SECRET/REDIRECT_URL are configured.
    const accessToken =
      provider === 'spotify' && dto.code
        ? await this.spotify.exchangeCode(dto.code)
        : 'stub';

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

  /**
   * Mint a signed connect invite for a guest (scoped API — this is how a
   * tenant surface hands a guest their connect link). 15-minute TTL.
   */
  @Post('spotify/invite')
  @Scopes('guest:connectors:write')
  invite(@Body() dto: AuthorizeDto) {
    const token = this.svc.signInvite(dto.guestId);
    return {
      guestId: dto.guestId,
      invite: token,
      connectPath: `/v1/connectors/spotify/connect?invite=${token}`,
      expiresInSeconds: 900,
    };
  }

  /**
   * Browser entry: 302 straight to Spotify consent. Public route (excluded
   * from tenant middleware) — requires a signed invite token; the state nonce
   * then binds the OAuth flow to the invite's guestId. Raw guestId entry was
   * removed (hardening, 2026-07-22): unsigned callers can no longer attach
   * taste to arbitrary guests.
   */
  @Get('spotify/connect')
  connectRedirect(
    @Query('invite') invite: string,
    @Res() res: ExpressResponse,
  ) {
    if (!invite) {
      res
        .status(400)
        .send(
          'invite token required — mint one via POST /v1/connectors/spotify/invite',
        );
      return;
    }
    let guestId: string;
    try {
      guestId = this.svc.verifyInvite(invite);
    } catch (e) {
      res.status(401).send((e as Error).message);
      return;
    }
    const { authorizeUrl } = this.svc.authorize('spotify', { guestId });
    res.redirect(authorizeUrl);
  }

  /** Browser return leg from Spotify — completes the flow and renders HTML. */
  @Get('spotify/callback')
  async connectCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: ExpressResponse,
  ) {
    const page = (inner: string, status = 200) =>
      res
        .status(status)
        .type('html')
        .send(
          `<!doctype html><meta charset="utf-8"><title>A-List × Spotify</title><body style="font-family:system-ui;background:#100C14;color:#EDE8F1;display:grid;place-items:center;min-height:95vh"><div style="max-width:560px;padding:32px;background:#191320;border:1px solid #2A2233;border-radius:14px">${inner}</div>`,
        );
    if (error) return page(`<h2>Spotify said no</h2><p>${error}</p>`, 400);
    if (!code || !state) return page('<h2>Missing code or state</h2>', 400);
    try {
      // Tenant context for the write path: the flagship tenant. The state
      // nonce (not the caller) determines the guest.
      const ctx = { tenantId: FLAGSHIP_TENANT_ID, scopes: [] } as TenantContext;
      const result = await this.svc.callback(ctx, 'spotify', {
        code,
        state,
      } as CallbackDto);
      return page(
        `<h2>Connected ✓</h2><p><b>${result.synced}</b> taste signals written to the ATLAS graph as consented connector evidence (consent ${result.consentId.slice(0, 8)}…).</p><p><a style="color:#DDA9D5" href="/dashboard">Open the ops console →</a></p>`,
      );
    } catch (e) {
      return page(`<h2>Connect failed</h2><p>${(e as Error).message}</p>`, 400);
    }
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
