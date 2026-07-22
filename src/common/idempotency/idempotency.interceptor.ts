import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Observable, lastValueFrom, of } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { TENANT_CONTEXT_KEY, TenantContext } from '../tenancy/tenant-context';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * DB-backed, race-safe idempotency for mutating handlers (defense-in-depth for
 * P0-4). When a client sends an `Idempotency-Key` header on a POST/PUT/PATCH/
 * DELETE, we guarantee at-most-once execution per `(tenantId, key)`:
 *
 *   1. INSERT-FIRST: before running the handler we `create` an IdempotencyRecord
 *      for `(tenantId, key)`. The DB unique constraint `(tenantId, key)` is the
 *      concurrency primitive — the winner of the race is whoever's INSERT lands.
 *   2. On unique-violation (P2002) a concurrent/previous request owns the key:
 *        - if that record already has a stored response, replay it;
 *        - otherwise the original is still in-flight → 409 Conflict.
 *   3. After the handler succeeds we persist its status + body onto the record so
 *      subsequent retries replay instead of re-executing. If the handler throws,
 *      we best-effort delete the placeholder so the client may safely retry.
 *
 * No `Idempotency-Key`, a non-mutating method, or a request without a resolved
 * TenantContext all pass straight through untouched — so with no client changes
 * behavior is identical to today.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> | Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest();
    const method: string = (req.method ?? '').toUpperCase();
    const key = (req.header?.('idempotency-key') ?? '').trim();

    if (!MUTATING_METHODS.has(method) || !key) {
      return next.handle();
    }

    // Same accessor the @Tenant() decorator / ScopesGuard use.
    const ctx: TenantContext | undefined = req[TENANT_CONTEXT_KEY];
    const tenantId = ctx?.tenantId;
    if (!tenantId) {
      // No tenant scope to key idempotency against — leave the request untouched.
      return next.handle();
    }

    const path: string = req.originalUrl ?? req.url ?? '';
    return this.handle(context, next, tenantId, key, method, path);
  }

  private async handle(
    context: ExecutionContext,
    next: CallHandler,
    tenantId: string,
    key: string,
    method: string,
    path: string,
  ): Promise<Observable<unknown>> {
    const res = context.switchToHttp().getResponse();

    // 1. Insert-first: claim the (tenantId, key) slot before doing any work.
    try {
      await this.prisma.idempotencyRecord.create({
        data: { tenantId, key, method, path },
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        return this.replayOrConflict(res, tenantId, key);
      }
      throw err;
    }

    // 2. We own the key — run the handler, then persist its outcome.
    let body: unknown;
    try {
      body = await lastValueFrom(next.handle());
    } catch (handlerErr) {
      // Placeholder must not permanently block retries of a failed request.
      await this.prisma.idempotencyRecord
        .deleteMany({ where: { tenantId, key } })
        .catch(() => undefined);
      throw handlerErr;
    }

    const statusCode: number = res?.statusCode ?? 200;
    await this.prisma.idempotencyRecord.updateMany({
      where: { tenantId, key },
      data: {
        statusCode,
        response: this.toJson(body),
      },
    });

    return of(body);
  }

  /**
   * A concurrent/previous request owns the key. Replay its stored response if the
   * original has completed, otherwise signal that it is still in-flight (409).
   */
  private async replayOrConflict(
    res: any,
    tenantId: string,
    key: string,
  ): Promise<Observable<unknown>> {
    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: { tenantId_key: { tenantId, key } },
    });

    if (existing && existing.statusCode != null) {
      if (res && typeof res.status === 'function') {
        res.status(existing.statusCode);
      }
      return of(existing.response ?? null);
    }

    throw new ConflictException(
      'A request with this Idempotency-Key is already in progress',
    );
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    );
  }

  /** Coerce a handler result into a JSON value Prisma can store (null-safe). */
  private toJson(body: unknown): Prisma.InputJsonValue {
    return (body ?? null) as Prisma.InputJsonValue;
  }
}
