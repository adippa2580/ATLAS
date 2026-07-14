import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * The tenant + scopes resolved for a request. In production these come from a
 * per-tenant OAuth token (see docs/architecture/primitive-api-spec.md). In dev,
 * DEV_TRUST_HEADERS lets X-Tenant-Id / X-Scopes headers stand in.
 */
export interface TenantContext {
  tenantId: string;
  scopes: string[];
  // Consumer-agent (MCP) tokens additionally carry a guest consent scope.
  guestId?: string;
}

export const TENANT_CONTEXT_KEY = 'atlasTenantContext';

/** Injects the resolved TenantContext into a controller handler. */
export const Tenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantContext => {
    const request = ctx.switchToHttp().getRequest();
    const tenant = request[TENANT_CONTEXT_KEY];
    if (!tenant) {
      throw new UnauthorizedException('Missing tenant context');
    }
    return tenant;
  },
);
