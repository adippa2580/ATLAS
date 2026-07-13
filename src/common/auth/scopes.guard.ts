import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SCOPES_KEY } from './scopes.decorator';
import { TENANT_CONTEXT_KEY, TenantContext } from '../tenancy/tenant-context';

/**
 * Enforces per-tenant scopes. A token holding a broader scope satisfies a
 * narrower requirement via prefix match on the `:` segments — e.g. `guest:*`
 * or `guest:evidence:*` satisfies `guest:evidence:write`.
 */
@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const ctx: TenantContext | undefined = request[TENANT_CONTEXT_KEY];
    if (!ctx) {
      throw new UnauthorizedException('Missing tenant context');
    }

    const held = new Set(ctx.scopes);
    const satisfied = required.every((req) => this.holds(held, req));
    if (!satisfied) {
      throw new ForbiddenException(
        `Missing required scope(s): ${required.join(', ')}`,
      );
    }
    return true;
  }

  private holds(held: Set<string>, required: string): boolean {
    if (held.has(required) || held.has('*')) {
      return true;
    }
    const parts = required.split(':');
    // Accept any held wildcard prefix, e.g. guest:* / guest:evidence:*
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join(':') + ':*';
      if (held.has(prefix)) {
        return true;
      }
    }
    return false;
  }
}
