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
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';
import { TasteModule } from '../taste/taste.module';
import { TasteService } from '../taste/taste.service';
import {
  SpotifyAdapter,
  TasteSignal,
} from '../../../integrations/spotify.adapter';
import { SoundcloudAdapter } from '../../../integrations/soundcloud.adapter';
import { AppleMusicAdapter } from '../../../integrations/applemusic.adapter';
import { InstagramAdapter } from '../../../integrations/instagram.adapter';
import { EventbriteAdapter } from '../../../integrations/eventbrite.adapter';
import { evidenceDedupeKey } from '../../../common/util/hash';
import { ConsentBasis } from '@prisma/client';

/**
 * The shared shape of a taste connector. `exchangeCode` is optional: OAuth
 * connectors (Spotify, SoundCloud) exchange a code server-side; Apple Music
 * passes its client-minted Music User Token through; Instagram stays stubbed.
 */
interface TasteConnector {
  authorizeUrl(state: string): string;
  fetchTaste(token: string): Promise<TasteSignal[]>;
  exchangeCode?(code: string): Promise<string>;
}

class AuthorizeDto {
  @IsString() guestId!: string;
}
/**
 * Mint a connect invite. Optional `ttlSeconds` makes the link shareable —
 * default 15 min for an in-session hand-off, up to 7 days for a link you send.
 */
class InviteDto {
  @IsString() guestId!: string;
  @IsOptional() @IsInt() @Min(60) @Max(604_800) ttlSeconds?: number;
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
class AppleBrowserCallbackDto {
  // The Music User Token minted client-side by MusicKit JS.
  @IsString() token!: string;
  // The CSRF state nonce issued to the connect page.
  @IsString() state!: string;
}

/**
 * The MusicKit JS page for the Apple Music browser handshake. Apple has no
 * server redirect OAuth: MusicKit runs in the browser with the app-level
 * developer token, the guest consents, and MusicKit returns a Music User Token
 * which we POST back to complete the connect. The developer token is app-level
 * and browser-safe (only the .p8 private key is secret).
 */
function appleConnectPage(developerToken: string, state: string): string {
  return `<!doctype html><meta charset="utf-8"><title>A-List × Apple Music</title>
<meta name="apple-music-developer-token" content="${developerToken}">
<meta name="apple-music-app-name" content="ATLAS">
<meta name="apple-music-app-build" content="1.0.0">
<body style="font-family:system-ui;background:#04050A;color:#F5F7FF;display:grid;place-items:center;min-height:95vh;margin:0">
<div style="max-width:560px;padding:32px;background:#0B0E17;border:1px solid #1b2233;border-radius:14px;text-align:center">
  <h2 style="margin-top:0">Connect Apple Music</h2>
  <p id="msg" style="color:#B8C0D4">Link your Apple Music so your taste flows into the ATLAS graph — consented, never a blast.</p>
  <button id="go" style="padding:12px 22px;border:0;border-radius:10px;background:#FA2D48;color:#fff;font-size:15px;cursor:pointer">Authorize Apple Music</button>
</div>
<script src="https://js-cdn.music.apple.com/musickit/v3/musickit.js" data-web-components async></script>
<script>
  var STATE=${JSON.stringify(state)};
  document.addEventListener('musickitloaded', function(){
    MusicKit.configure({
      developerToken: document.querySelector('meta[name=apple-music-developer-token]').content,
      app: { name: 'ATLAS', build: '1.0.0' }
    });
  });
  document.getElementById('go').addEventListener('click', async function(){
    var msg=document.getElementById('msg'), btn=document.getElementById('go');
    btn.disabled=true; msg.textContent='Waiting for Apple sign-in…';
    try{
      var music=MusicKit.getInstance();
      var userToken=await music.authorize();
      msg.textContent='Syncing your taste…';
      var r=await fetch('/v1/connectors/applemusic/browser-callback',{
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ token:userToken, state:STATE })
      });
      var j=await r.json();
      if(r.ok){ msg.innerHTML='<b>Connected ✓</b> '+(j.synced||0)+' taste signals written. <a style="color:#60A5FA" href="/dashboard">Open the console →</a>'; btn.style.display='none'; }
      else { msg.textContent='Connect failed: '+(j.message||r.status); btn.disabled=false; }
    }catch(e){ msg.textContent='Apple sign-in cancelled or failed.'; btn.disabled=false; }
  });
</script>`;
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
    private readonly soundcloud: SoundcloudAdapter,
    private readonly applemusic: AppleMusicAdapter,
    private readonly instagram: InstagramAdapter,
    private readonly eventbrite: EventbriteAdapter,
    private readonly config: ConfigService,
  ) {}

  /** Resolve a provider slug to its taste connector (null if unknown). */
  private adapterFor(provider: string): TasteConnector | null {
    switch (provider) {
      case 'spotify':
        return this.spotify;
      case 'soundcloud':
        return this.soundcloud;
      case 'applemusic':
        return this.applemusic;
      case 'instagram':
        return this.instagram;
      default:
        return null;
    }
  }

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
    const adapter = this.adapterFor(provider);
    if (!adapter) {
      throw new UnauthorizedException(`Unknown connector: ${provider}`);
    }
    // Unpredictable, single-use nonce instead of the guessable `provider:guestId`.
    const state = randomBytes(32).toString('hex');
    this.pendingStates.set(state, {
      provider,
      guestId: dto.guestId,
      createdAt: Date.now(),
    });
    return { provider, authorizeUrl: adapter.authorizeUrl(state), state };
  }

  /**
   * Begin the Eventbrite OAuth connect — a tenant/operator authorises ATLAS to
   * read their organisation's events. Uses the same CSRF nonce store as the
   * taste connectors. `subjectId` is the operator/guest who initiated it.
   */
  eventbriteAuthorize(subjectId: string) {
    const state = randomBytes(32).toString('hex');
    this.pendingStates.set(state, {
      provider: 'eventbrite',
      guestId: subjectId,
      createdAt: Date.now(),
    });
    return {
      provider: 'eventbrite',
      authorizeUrl: this.eventbrite.authorizeUrl(state),
      state,
    };
  }

  /**
   * Complete the Eventbrite OAuth connect: validate the CSRF nonce, exchange the
   * code for an access token (stub-first), and report the connection. Unlike a
   * taste connector this does NOT write guest evidence — Eventbrite is an
   * organisation-level demand source; the token authorises event ingestion.
   */
  async eventbriteCallback(state: string, code: string) {
    const pending = this.pendingStates.get(state);
    if (!pending || pending.provider !== 'eventbrite') {
      throw new UnauthorizedException('Invalid or expired OAuth state');
    }
    this.pendingStates.delete(state); // single-use
    const token = await this.eventbrite.exchangeCode(code);
    return {
      provider: 'eventbrite',
      connected: true,
      subjectId: pending.guestId,
      live: this.eventbrite.oauthConfigured,
      tokenPreview: `${token.slice(0, 10)}…`,
    };
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

    const adapter = this.adapterFor(provider);
    if (!adapter) throw new UnauthorizedException('Unknown connector');

    // Server-side code→token exchange where the connector supports it (never
    // accept a token from the client). Spotify + SoundCloud exchange the OAuth
    // code; Apple Music passes its Music User Token through; Instagram stays
    // stubbed pending a Meta app review.
    const accessToken =
      adapter.exchangeCode && dto.code
        ? await adapter.exchangeCode(dto.code)
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

    const signals = await adapter.fetchTaste(accessToken);

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

  /**
   * App-level Apple Music developer token, for the MusicKit browser handshake.
   * Browser-safe (only the .p8 private key is secret). Throws if Apple Music is
   * not configured.
   */
  appleDeveloperToken(): Promise<string> {
    return this.applemusic.developerToken();
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
  invite(@Body() dto: InviteDto) {
    const ttl = dto.ttlSeconds ?? 900;
    const token = this.svc.signInvite(dto.guestId, ttl);
    return {
      guestId: dto.guestId,
      invite: token,
      connectPath: `/v1/connectors/spotify/connect?invite=${token}`,
      expiresInSeconds: ttl,
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

  /**
   * Mint a signed Eventbrite connect invite (shareable link to send to an
   * operator). Same invite infra as the taste connectors; default 15 min,
   * `ttlSeconds` up to 7 days for a send-and-forget link.
   */
  @Post('eventbrite/invite')
  @Scopes('guest:connectors:write')
  eventbriteInvite(@Body() dto: InviteDto) {
    const ttl = dto.ttlSeconds ?? 900;
    const token = this.svc.signInvite(dto.guestId, ttl);
    return {
      guestId: dto.guestId,
      invite: token,
      connectPath: `/v1/connectors/eventbrite/connect?invite=${token}`,
      expiresInSeconds: ttl,
    };
  }

  /**
   * Browser entry for Eventbrite. Public route (excluded from tenant
   * middleware) — a signed invite gates it; the state nonce then binds the
   * OAuth flow. 302s to Eventbrite consent (or straight to our callback with a
   * stub code when OAuth isn't configured).
   */
  @Get('eventbrite/connect')
  eventbriteConnect(
    @Query('invite') invite: string,
    @Res() res: ExpressResponse,
  ) {
    if (!invite) {
      res
        .status(400)
        .send(
          'invite token required — mint one via POST /v1/connectors/eventbrite/invite',
        );
      return;
    }
    let subjectId: string;
    try {
      subjectId = this.svc.verifyInvite(invite);
    } catch (e) {
      res.status(401).send((e as Error).message);
      return;
    }
    const { authorizeUrl } = this.svc.eventbriteAuthorize(subjectId);
    res.redirect(authorizeUrl);
  }

  /** Browser return leg from Eventbrite — completes the OAuth handshake. */
  @Get('eventbrite/callback')
  async eventbriteCallback(
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
          `<!doctype html><meta charset="utf-8"><title>A-List × Eventbrite</title><body style="font-family:system-ui;background:#100C14;color:#EDE8F1;display:grid;place-items:center;min-height:95vh"><div style="max-width:560px;padding:32px;background:#191320;border:1px solid #2A2233;border-radius:14px">${inner}</div>`,
        );
    if (error) return page(`<h2>Eventbrite said no</h2><p>${error}</p>`, 400);
    if (!code || !state) return page('<h2>Missing code or state</h2>', 400);
    try {
      const result = await this.svc.eventbriteCallback(state, code);
      return page(
        `<h2>Connected ✓</h2><p>Eventbrite is now linked${result.live ? '' : ' <b>(stub — no live token exchange in this build)</b>'}. Atlas can ingest this account's events as demand signals.</p><p><a style="color:#DDA9D5" href="/dashboard">Open the ops console →</a></p>`,
      );
    } catch (e) {
      return page(`<h2>Connect failed</h2><p>${(e as Error).message}</p>`, 400);
    }
  }

  /** Mint a signed connect invite for the Apple Music browser handshake. */
  @Post('applemusic/invite')
  @Scopes('guest:connectors:write')
  appleInvite(@Body() dto: InviteDto) {
    const ttl = dto.ttlSeconds ?? 900;
    const token = this.svc.signInvite(dto.guestId, ttl);
    return {
      guestId: dto.guestId,
      invite: token,
      connectPath: `/v1/connectors/applemusic/connect?invite=${token}`,
      expiresInSeconds: ttl,
    };
  }

  /**
   * Browser entry for Apple Music. Public route (excluded from tenant
   * middleware) — a signed invite binds the flow to a guest; we issue the state
   * nonce and serve the MusicKit JS page carrying the app-level developer token.
   */
  @Get('applemusic/connect')
  async appleConnect(
    @Query('invite') invite: string,
    @Res() res: ExpressResponse,
  ) {
    if (!invite) {
      res
        .status(400)
        .send(
          'invite token required — mint one via POST /v1/connectors/applemusic/invite',
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
    let developerToken: string;
    try {
      developerToken = await this.svc.appleDeveloperToken();
    } catch {
      res
        .status(503)
        .send('Apple Music is not configured on this deployment yet.');
      return;
    }
    const { state } = this.svc.authorize('applemusic', { guestId });
    res.type('html').send(appleConnectPage(developerToken, state));
  }

  /**
   * Return leg from the MusicKit page: the browser posts the Music User Token
   * here. Public route; the state nonce (not the caller) determines the guest,
   * and the write runs under the flagship tenant.
   */
  @Post('applemusic/browser-callback')
  async appleBrowserCallback(@Body() dto: AppleBrowserCallbackDto) {
    const ctx = { tenantId: FLAGSHIP_TENANT_ID, scopes: [] } as TenantContext;
    return this.svc.callback(ctx, 'applemusic', {
      code: dto.token,
      state: dto.state,
    } as CallbackDto);
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
