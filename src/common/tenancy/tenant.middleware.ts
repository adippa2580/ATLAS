import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NextFunction, Request, Response } from 'express';
import type { AuthMode } from '../config/configuration';
import { TokenVerifier } from '../auth/token-verifier';
import { TENANT_CONTEXT_KEY, TenantContext } from './tenant-context';

/**
 * Resolves the per-request TenantContext.
 *
 * Two auth modes (see AUTH_MODE / configuration.ts):
 *  - 'trust-headers' (DEFAULT, legacy/dev): trust `X-Tenant-Id` and a
 *    space/comma-separated `X-Scopes` header. This keeps the live demo working.
 *  - 'oauth' (production): verify the `Authorization: Bearer` JWT against the
 *    configured OIDC JWKS and build the TenantContext from verified claims;
 *    respond 401 when the token is missing or invalid.
 *
 * Webhook routes authenticate by signature (not tenant token) and simply carry
 * no TenantContext through here — downstream guards enforce as needed.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(
    private readonly config: ConfigService,
    private readonly tokenVerifier: TokenVerifier,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authMode = this.config.get<AuthMode>('authMode') ?? 'trust-headers';

    if (authMode === 'oauth') {
      await this.resolveFromToken(req, res, next);
      return;
    }

    this.resolveFromHeaders(req);
    next();
  }

  /** Legacy/dev path: trust client-supplied tenant + scope headers. */
  private resolveFromHeaders(req: Request): void {
    const tenantId = (req.header('x-tenant-id') ?? '').trim();
    if (tenantId) {
      const scopes = (req.header('x-scopes') ?? '')
        .split(/[\s,]+/)
        .filter(Boolean);
      const guestId = (req.header('x-guest-id') ?? '').trim() || undefined;
      const ctx: TenantContext = { tenantId, scopes, guestId };
      (req as any)[TENANT_CONTEXT_KEY] = ctx;
    }
  }

  /**
   * Production path: verify the Bearer JWT and attach the derived TenantContext.
   * A missing/invalid token yields a 401 here so unauthenticated requests never
   * reach handlers or scope guards.
   */
  private async resolveFromToken(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const ctx = await this.tokenVerifier.verify(req.header('authorization'));
    if (!ctx) {
      res.status(401).json({
        statusCode: 401,
        message: 'Missing or invalid bearer token',
        error: 'Unauthorized',
      });
      return;
    }
    (req as any)[TENANT_CONTEXT_KEY] = ctx;
    next();
  }
}
