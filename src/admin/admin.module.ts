import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Module,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { IsOptional, IsString } from 'class-validator';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { PrismaService } from '../common/prisma/prisma.service';
import { TenantContext } from '../common/tenancy/tenant-context';
import {
  CatalogIngestModule,
  CatalogIngestService,
} from '../modules/marketing/entities/catalog-ingest.module';

/** The A-List flagship tenant — where the operator's taste graph lives. */
const FLAGSHIP_TENANT_ID = '00000000-0000-0000-0000-00000000a115';
const COOKIE_NAME = 'atlas_admin';
const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8h

class LoginDto {
  @IsString() username!: string;
  @IsString() password!: string;
}
class LoadDto {
  @IsOptional() @IsString() city?: string;
}

/** Read the named cookie out of a raw Cookie header (no cookie-parser dep). */
function readCookie(header: string | undefined, name: string): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return '';
}

const round = (n: number) => Math.round(n * 1000) / 1000;

@Injectable()
export class AdminService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogIngestService,
  ) {}

  private get sessionSecret(): string {
    return this.config.get<string>('admin.sessionSecret') ?? '';
  }

  private get users(): Record<string, string> {
    return this.config.get<Record<string, string>>('admin.users') ?? {};
  }

  /** Admin login only works when a session secret AND ≥1 user are configured. */
  get configured(): boolean {
    return !!this.sessionSecret && Object.keys(this.users).length > 0;
  }

  /** Constant-time credential check (hash both sides so length can't leak). */
  verifyCredentials(username: string, password: string): boolean {
    const stored = this.users[username];
    if (!stored) return false;
    const a = createHash('sha256').update(password).digest();
    const b = createHash('sha256').update(stored).digest();
    return timingSafeEqual(a, b);
  }

  /** HMAC-signed session token: base64url(payload).base64url(sig). */
  issueSession(sub: string, now = Math.floor(Date.now() / 1000)): string {
    const payload = Buffer.from(
      JSON.stringify({ sub, exp: now + SESSION_TTL_SECONDS }),
    ).toString('base64url');
    const sig = createHmac('sha256', this.sessionSecret)
      .update(payload)
      .digest('base64url');
    return `${payload}.${sig}`;
  }

  /** Verify a session token → username, or null (bad sig / expired / malformed). */
  verifySession(
    token: string,
    now = Math.floor(Date.now() / 1000),
  ): string | null {
    if (!token || !this.sessionSecret) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = createHmac('sha256', this.sessionSecret)
      .update(payload)
      .digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (
        typeof data.sub !== 'string' ||
        typeof data.exp !== 'number' ||
        data.exp < now
      ) {
        return null;
      }
      return data.sub;
    } catch {
      return null;
    }
  }

  /** A snapshot of the flagship tenant's taste graph + the global catalog. */
  async graph() {
    const t = FLAGSHIP_TENANT_ID;
    const [
      entityKinds,
      guests,
      consents,
      crews,
      evidenceTotal,
      affinityTotal,
      affinities,
      recentEvidence,
    ] = await Promise.all([
      this.prisma.entity.groupBy({ by: ['kind'], _count: { _all: true } }),
      this.prisma.guest.count({ where: { tenantId: t } }),
      this.prisma.consentGrant.count({
        where: { tenantId: t, revokedAt: null },
      }),
      this.prisma.crew.count({ where: { tenantId: t } }),
      this.prisma.affinityEvidence.count({ where: { tenantId: t } }),
      this.prisma.guestAffinity.count({ where: { tenantId: t } }),
      this.prisma.guestAffinity.findMany({
        where: { tenantId: t, muted: false },
        orderBy: { score: 'desc' },
        take: 400,
        select: { subjectType: true, subjectRef: true, score: true },
      }),
      this.prisma.affinityEvidence.findMany({
        where: { tenantId: t },
        orderBy: { observedAt: 'desc' },
        take: 12,
        select: {
          subjectType: true,
          subjectRef: true,
          signal: true,
          provenance: true,
          weight: true,
          observedAt: true,
        },
      }),
    ]);

    // Aggregate the graph by subject (sum score, count distinct-ish guests).
    const bySubject = new Map<
      string,
      { subjectType: string; subjectRef: string; sum: number; guests: number }
    >();
    for (const a of affinities) {
      const k = `${a.subjectType}:${a.subjectRef}`;
      const cur = bySubject.get(k) ?? {
        subjectType: a.subjectType,
        subjectRef: a.subjectRef,
        sum: 0,
        guests: 0,
      };
      cur.sum += a.score;
      cur.guests += 1;
      bySubject.set(k, cur);
    }
    const ranked = [...bySubject.values()]
      .sort((x, y) => y.sum - x.sum)
      .map((s) => ({
        subjectType: s.subjectType,
        subjectRef: s.subjectRef,
        score: round(s.sum),
        guests: s.guests,
      }));

    return {
      tenant: 'A-List (flagship)',
      entities: Object.fromEntries(
        entityKinds.map((e) => [e.kind, e._count._all]),
      ),
      counts: {
        guests,
        consents,
        crews,
        evidence: evidenceTotal,
        affinities: affinityTotal,
      },
      topArtists: ranked.filter((s) => s.subjectType === 'artist').slice(0, 10),
      topGenres: ranked.filter((s) => s.subjectType === 'genre').slice(0, 10),
      recentEvidence,
    };
  }

  /** Load/refresh: ingest the class-3 catalog for a city, then return the graph. */
  async load(city = 'Miami') {
    const ctx = { tenantId: FLAGSHIP_TENANT_ID, scopes: [] } as TenantContext;
    const ingested = await this.catalog.ingest(ctx, { city });
    return { ingested, graph: await this.graph() };
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly svc: AdminService) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const token = readCookie(req.headers?.cookie, COOKIE_NAME);
    const user = this.svc.verifySession(token);
    if (!user) throw new UnauthorizedException('admin session required');
    (req as unknown as { adminUser: string }).adminUser = user;
    return true;
  }
}

@ApiTags('admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly svc: AdminService) {}

  private get secureCookies(): boolean {
    return process.env.NODE_ENV === 'production';
  }

  @Get()
  page(@Res() res: Response): void {
    res.type('html').send(adminPage());
  }

  @Post('login')
  login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): { ok: true; user: string } {
    if (!this.svc.configured) {
      throw new ServiceUnavailableException('Admin login is not configured');
    }
    if (!this.svc.verifyCredentials(dto.username, dto.password)) {
      throw new UnauthorizedException('Invalid credentials');
    }
    res.cookie(COOKIE_NAME, this.svc.issueSession(dto.username), {
      httpOnly: true,
      secure: this.secureCookies,
      sameSite: 'lax',
      path: '/admin',
      maxAge: SESSION_TTL_SECONDS * 1000,
    });
    return { ok: true, user: dto.username };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response): { ok: true } {
    res.clearCookie(COOKIE_NAME, { path: '/admin' });
    return { ok: true };
  }

  @Get('session')
  session(@Req() req: Request): {
    authenticated: boolean;
    user: string | null;
    configured: boolean;
  } {
    const user = this.svc.verifySession(
      readCookie(req.headers?.cookie, COOKIE_NAME),
    );
    return {
      authenticated: !!user,
      user: user ?? null,
      configured: this.svc.configured,
    };
  }

  @Get('graph')
  @UseGuards(AdminGuard)
  graph() {
    return this.svc.graph();
  }

  @Post('load')
  @UseGuards(AdminGuard)
  load(@Body() dto: LoadDto) {
    return this.svc.load(dto.city);
  }
}

/** The self-contained admin console (Atlas v3.1 dark, red-free). */
function adminPage(): string {
  return `<!doctype html><meta charset="utf-8"><title>ATLAS · Admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{--bg:#04050A;--card:#0B0E17;--input:#111524;--line:#1b2233;--ink:#F5F7FF;--mut:#B8C0D4;--faint:#6B7280;--violet:#A78BFA;--cyan:#22D3EE;--blue:#60A5FA;--amber:#FBBF24;--mint:#34D399}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:"Helvetica Neue",system-ui,sans-serif;min-height:100vh}
  .wrap{max-width:1040px;margin:0 auto;padding:28px 20px}
  h1{font-size:19px;letter-spacing:.5px;margin:0 0 2px}
  .sub{color:var(--faint);font-size:12px;margin-bottom:22px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px;margin-bottom:16px}
  label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--mut);margin:12px 0 6px}
  input{width:100%;padding:11px 13px;background:var(--input);border:1px solid var(--line);border-radius:9px;color:var(--ink);font-size:14px}
  button{appearance:none;cursor:pointer;border:0;border-radius:9px;font-size:13px;font-weight:600;padding:10px 18px;font-family:inherit}
  .primary{background:var(--violet);color:#0b0b14}
  .ghost{background:transparent;border:1px solid var(--line);color:var(--ink)}
  .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .err{color:var(--amber);font-size:13px;margin-top:10px;min-height:16px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
  .kpi{background:var(--input);border:1px solid var(--line);border-radius:10px;padding:12px}
  .kpi .k{font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--faint)}
  .kpi .v{font-size:22px;font-weight:600;margin-top:3px}
  h3{font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--mut);margin:20px 0 10px}
  .bars .b{display:flex;align-items:center;gap:10px;margin:6px 0;font-size:13px}
  .bars .b span:first-child{width:150px;color:var(--ink)}
  .tk{flex:1;height:7px;background:var(--input);border-radius:99px;overflow:hidden}
  .tk i{display:block;height:100%;background:linear-gradient(90deg,var(--violet),var(--cyan))}
  .n{width:52px;text-align:right;color:var(--mut);font-variant-numeric:tabular-nums}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th{text-align:left;color:var(--faint);font-weight:500;text-transform:uppercase;letter-spacing:.5px;font-size:10px;padding:6px 8px;border-bottom:1px solid var(--line)}
  td{padding:6px 8px;border-bottom:1px solid #10141f;color:var(--mut)}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:20px}
  @media(max-width:720px){.two{grid-template-columns:1fr}.bars .b span:first-child{width:110px}}
  .pill{font-size:10px;color:var(--faint)}
  .muted{color:var(--faint);font-size:12px}
</style>
<body><div class="wrap">
  <h1>ATLAS · Admin</h1>
  <div class="sub">Registered employees · taste-graph console</div>

  <div class="card" id="loginCard" hidden>
    <div style="font-size:14px;margin-bottom:4px">Sign in</div>
    <div class="muted">ATLAS employees only.</div>
    <label>Username</label><input id="u" autocomplete="username" placeholder="adrian / jack">
    <label>Password</label><input id="p" type="password" autocomplete="current-password">
    <div class="row" style="margin-top:16px"><button class="primary" id="loginBtn">Sign in</button></div>
    <div class="err" id="loginErr"></div>
  </div>

  <div id="app" hidden>
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <div><b id="who">—</b> <span class="pill">· signed in</span></div>
        <div class="row">
          <input id="city" placeholder="City (Miami)" style="width:150px">
          <button class="primary" id="loadBtn">⟳ Load / refresh graph</button>
          <button class="ghost" id="logoutBtn">Sign out</button>
        </div>
      </div>
      <div class="err" id="appMsg"></div>
    </div>
    <div class="card">
      <div class="muted" id="tenant">—</div>
      <h3>Graph totals</h3>
      <div class="grid" id="kpis"></div>
      <div class="two">
        <div><h3>Top artists</h3><div class="bars" id="artists"></div></div>
        <div><h3>Top genres</h3><div class="bars" id="genres"></div></div>
      </div>
      <h3>Recent evidence (writes)</h3>
      <div style="overflow-x:auto"><table id="evtbl"><thead><tr><th>subject</th><th>signal</th><th>provenance</th><th>weight</th><th>when</th></tr></thead><tbody></tbody></table></div>
    </div>
  </div>
</div>
<script>
  var $=function(s){return document.querySelector(s)};
  async function api(path,opts){var r=await fetch(path,Object.assign({headers:{'Content-Type':'application/json'}},opts||{}));var j=null;try{j=await r.json()}catch(e){}; return {ok:r.ok,status:r.status,json:j}}
  function esc(s){return String(s==null?'':s).replace(/[&<>\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]})}
  function bars(host,rows){var max=Math.max.apply(null,rows.map(function(r){return r.score||0}).concat([1]));
    host.innerHTML=rows.length?rows.map(function(r){var w=Math.round(100*(r.score||0)/max);
      return '<div class="b"><span>'+esc(r.subjectRef)+'</span><span class="tk"><i style="width:'+w+'%"></i></span><span class="n">'+(r.score||0)+'</span></div>'}).join(''):'<div class="muted">none yet</div>'}
  function kpi(k,v){return '<div class="kpi"><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+'</div></div>'}
  function renderGraph(g){
    $('#tenant').textContent='Tenant: '+g.tenant;
    var e=g.entities||{},c=g.counts||{};
    $('#kpis').innerHTML=[kpi('Artists',e.artist||0),kpi('Genres',e.genre||0),kpi('Venues',e.venue||0),kpi('Events',e.event||0),
      kpi('Guests',c.guests||0),kpi('Consents',c.consents||0),kpi('Evidence',c.evidence||0),kpi('Affinities',c.affinities||0),kpi('Crews',c.crews||0)].join('');
    bars($('#artists'),g.topArtists||[]); bars($('#genres'),g.topGenres||[]);
    $('#evtbl tbody').innerHTML=(g.recentEvidence||[]).map(function(r){return '<tr><td><span class="pill">'+esc(r.subjectType)+'</span> '+esc(r.subjectRef)+'</td><td>'+esc(r.signal)+'</td><td>'+esc(r.provenance)+'</td><td>'+esc(r.weight)+'</td><td>'+esc((r.observedAt||'').slice(0,16).replace('T',' '))+'</td></tr>'}).join('')||'<tr><td colspan="5" class="muted">no evidence yet</td></tr>';
  }
  async function loadGraph(){var r=await api('/admin/graph');if(r.ok){renderGraph(r.json)}else if(r.status===401){show(false)}}
  function show(authed){$('#app').hidden=!authed;$('#loginCard').hidden=authed}
  async function boot(){var s=await api('/admin/session');
    if(!s.json||!s.json.configured){$('#loginCard').hidden=false;$('#loginErr').textContent='Admin login is not configured on this deployment yet.';$('#loginBtn').disabled=true;return}
    if(s.json.authenticated){$('#who').textContent=s.json.user;show(true);loadGraph()}else{show(false)}}
  $('#loginBtn').addEventListener('click',async function(){var b=this;b.disabled=true;$('#loginErr').textContent='';
    var r=await api('/admin/login',{method:'POST',body:JSON.stringify({username:$('#u').value.trim(),password:$('#p').value})});
    b.disabled=false;
    if(r.ok){$('#who').textContent=r.json.user;show(true);loadGraph()}else{$('#loginErr').textContent=(r.json&&r.json.message)||'Sign-in failed'}});
  $('#logoutBtn').addEventListener('click',async function(){await api('/admin/logout',{method:'POST'});show(false)});
  $('#loadBtn').addEventListener('click',async function(){var b=this;b.disabled=true;$('#appMsg').textContent='Loading catalog + graph…';
    var r=await api('/admin/load',{method:'POST',body:JSON.stringify({city:($('#city').value.trim()||undefined)})});
    b.disabled=false;
    if(r.ok){renderGraph(r.json.graph);var ing=r.json.ingested||{};$('#appMsg').textContent='Loaded · '+(ing.created!=null?ing.created+' entities ingested':'catalog refreshed')}
    else if(r.status===401){show(false)}else{$('#appMsg').textContent=(r.json&&r.json.message)||'Load failed'}});
  boot();
</script>`;
}

@Module({
  imports: [CatalogIngestModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}
