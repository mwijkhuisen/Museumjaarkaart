-- The five database logins (A§8). Runs once as the superuser from
-- /docker-entrypoint-initdb.d/ on a new volume (P1e), and in the integration
-- tests. Passwords are read server-side from the file secrets (prefix + login),
-- so in production they never appear in SQL text or statement logs (dev-db.ts,
-- for development and tests only, writes its throw-away passwords with a COPY).
-- Idempotent. After rotating a db_* secret, run this file again by hand. It
-- changes cluster-wide state (roles; CONNECT on postgres and template1): one
-- database per cluster, never point it at a shared server.
DO $$
DECLARE
  prefix text := coalesce(nullif(current_setting('mjk.secret_prefix', true), ''), '/run/secrets/db_');
  login text;
  pw text;
BEGIN
  FOREACH login IN ARRAY ARRAY['mjk_migrator', 'mjk_api', 'mjk_ssr', 'mjk_worker', 'mjk_backup'] LOOP
    BEGIN
      pw := btrim(pg_read_file(prefix || login), E' \t\r\n');
      IF pw !~ '^[A-Za-z0-9_-]{24,}$' THEN RAISE EXCEPTION USING ERRCODE = '22023'; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = login) THEN EXECUTE format('CREATE ROLE %I', login); END IF;
      EXECUTE format(
        'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', login, pw);
    EXCEPTION WHEN OTHERS THEN
      -- fixed text: the original error's context could quote the password
      RAISE EXCEPTION 'roles.sql: cannot set up login % (SQLSTATE %)', login, SQLSTATE;
    END;
  END LOOP;
  EXECUTE format('ALTER DATABASE %I OWNER TO mjk_migrator', current_database());
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO mjk_api, mjk_ssr, mjk_worker, mjk_backup', current_database());
  REVOKE CONNECT ON DATABASE postgres, template1 FROM PUBLIC;  -- no login reaches another database
END $$;

-- A§8: mjk_backup reads everything and is a member of nothing else. SET FALSE:
-- no SET ROLE pg_read_all_data. On an existing membership GRANT sets the options
-- it names, so re-applying this file also lowers an older SET TRUE.
GRANT pg_read_all_data TO mjk_backup WITH INHERIT TRUE, SET FALSE;
