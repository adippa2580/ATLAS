-- Row-Level Security (P1) — DB-layer tenant isolation as defense-in-depth behind
-- the app's tenantId filtering.
--
-- Design: every table that carries a "tenantId" column gets a tenant_isolation
-- policy. The policy is PERMISSIVE when the session GUC `app.current_tenant` is
-- unset (NULL) — so migrations, the seed job, and admin/maintenance connections
-- (which never set it) are unaffected — and RESTRICTS to the matching tenant when
-- the app sets it per request (see the Prisma tenant-context extension /
-- runWithTenant helper). FORCE ROW LEVEL SECURITY makes the policy apply to the
-- table owner too, since the app connects as the owning `atlas` role.
--
-- Rollout: shipping this migration is safe and non-breaking (permissive until the
-- GUC is set). Isolation becomes ENFORCING for a request the moment the app binds
-- app.current_tenant for that request's transaction.

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_schema = c.table_schema
     AND tb.table_name = c.table_name
     AND tb.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public'
      AND c.column_name = 'tenantId'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING (current_setting(''app.current_tenant'', true) IS NULL '
      '       OR "tenantId" = current_setting(''app.current_tenant'', true)) '
      'WITH CHECK (current_setting(''app.current_tenant'', true) IS NULL '
      '       OR "tenantId" = current_setting(''app.current_tenant'', true))',
      t);
  END LOOP;
END $$;
