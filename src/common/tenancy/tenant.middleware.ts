import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NextFunction, Request, Response } from 'express';
import { TENANT_CONTEXT_KEY, TenantContext } from './tenant-context';

/**
 * Resolves the per-request TenantContext.
 *
 * MVP/dev: when DEV_TRUST_HEADERS is on, trust `X-Tenant-Id` and a
 * space-separated `X-Scopes` header. In production this is replaced by OAuth2
 * client-credentials token verification that yields the same TenantContext.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly config: ConfigService) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const trustHeaders = this.config.get<boolean>('devTrustHeaders');

    if (trustHeaders) {
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

    // Webhook routes authenticate by signature, not tenant token — skip here.
    next();
  }
}
