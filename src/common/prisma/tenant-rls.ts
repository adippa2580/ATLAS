/**
 * ROW-LEVEL SECURITY — APP-SIDE BINDING
 * =====================================
 *
 * Migration `0008_row_level_security` enabled Postgres RLS on every
 * `tenantId`-bearing table with a `tenant_isolation` policy:
 *
 *   USING (
 *     current_setting('app.current_tenant', true) IS NULL
 *     OR "tenantId" = current_setting('app.current_tenant', true)
 *   )
 *
 * ROLLOUT (deliberately non-breaking):
 *   - Because the policy is a no-op when the `app.current_tenant` GUC is unset,
 *     RLS ships PERMISSIVE. Existing queries keep working untouched — nothing
 *     breaks on deploy.
 *   - To make isolation ENFORCING for a piece of request-scoped work, wrap that
 *     work's DB access in `runWithTenant`:
 *
 *       await runWithTenant(prisma, ctx.tenantId, async (tx) => {
 *         return tx.booking.findMany();   // RLS now filters to ctx.tenantId
 *       });
 *
 *     Inside the transaction the GUC is set, so the policy's second branch
 *     applies and Postgres enforces `"tenantId" = ctx.tenantId` on every row
 *     touched by `tx` — a DB-layer backstop under the app's own `where` clauses.
 *   - Follow-up: a Nest interceptor that auto-binds every request's transaction
 *     to its `TenantContext.tenantId`, so handlers get enforcing RLS for free.
 *     Until then, binding is opt-in per handler via `runWithTenant`.
 */

import type { PrismaService } from './prisma.service';

/**
 * Strict UUID (v1–v5) matcher used as the injection guard. The task permits the
 * looser `^[0-9a-fA-F-]{36}$`; we use the canonical form for a tighter guard
 * while still accepting every real tenant id.
 */
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * INJECTION GUARD.
 *
 * `SET LOCAL` does not accept bind parameters, so the tenant id must be
 * interpolated into the SQL string. That is only safe if the value is proven to
 * be a plain UUID first — this function is the single chokepoint that proves it.
 * Any value containing quotes, semicolons, whitespace, or other SQL metacharacters
 * (e.g. `x'; DROP TABLE users; --`) fails the match and is rejected before it can
 * reach the query string.
 *
 * @returns the validated tenant id, so callers can inline the call at the
 *          interpolation site: `SET LOCAL app.current_tenant = '${assertTenantId(id)}'`.
 * @throws  {Error} if `tenantId` is not a well-formed UUID.
 */
export function assertTenantId(tenantId: string): string {
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) {
    throw new Error(
      `Invalid tenantId for RLS binding: ${JSON.stringify(tenantId)}`,
    );
  }
  return tenantId;
}

/**
 * Run `fn` inside a transaction bound to `tenantId`, under ENFORCING RLS.
 *
 * This is the SANCTIONED way to run tenant-scoped DB work: it opens a
 * transaction, sets the `app.current_tenant` session GUC via `SET LOCAL` (which
 * auto-resets when the transaction ends — commit or rollback), then hands the
 * transactional client `tx` to `fn`. Every query `fn` issues on `tx` is filtered
 * by the `tenant_isolation` policy to rows where `"tenantId" = tenantId`.
 *
 * The tenant id is validated by {@link assertTenantId} before interpolation, so
 * the un-parameterizable `SET LOCAL` string cannot be used to inject SQL.
 *
 * NOTE: The cross-tenant projection path (which must read rows from multiple
 * tenants) deliberately does NOT use this helper — it runs outside a bound
 * transaction so the permissive branch of the policy applies. Do not "fix" that
 * path by wrapping it here; doing so would break the intended cross-tenant read.
 *
 * @param prisma   the PrismaService (extends PrismaClient).
 * @param tenantId the tenant to bind; must be a UUID.
 * @param fn       callback receiving the transactional client `tx`.
 * @returns whatever `fn` resolves to.
 * @throws  {Error} (from `assertTenantId`) if `tenantId` is not a valid UUID.
 */
export async function runWithTenant<T>(
  prisma: PrismaService,
  tenantId: string,
  fn: (
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
  ) => Promise<T>,
): Promise<T> {
  const validated = assertTenantId(tenantId);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL app.current_tenant = '${validated}'`,
    );
    return fn(tx);
  });
}
