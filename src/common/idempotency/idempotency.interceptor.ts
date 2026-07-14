import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';

/**
 * Minimal idempotency for mutating handlers. When an `Idempotency-Key` header is
 * present, the first response is cached (in-memory for MVP; Redis in prod) and
 * replayed for repeat keys. Booking/pay handlers require the header at the DB
 * layer via unique constraints; this interceptor short-circuits duplicates early.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly cache = new Map<string, unknown>();

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const key = req.header?.('idempotency-key');
    if (!key) {
      return next.handle();
    }
    const tenantId =
      req[Symbol.for('noop')] ?? req.headers['x-tenant-id'] ?? '';
    const cacheKey = `${tenantId}:${req.method}:${req.originalUrl}:${key}`;
    if (this.cache.has(cacheKey)) {
      return of(this.cache.get(cacheKey));
    }
    return next.handle().pipe(tap((body) => this.cache.set(cacheKey, body)));
  }
}
