-- migrate:up
-- P2a (A§8, A§9, A§10): accounts, sessions, email codes, invites, the rate limiter, the audit log and the
-- content IP log. Limits below match packages/contracts/src/auth.ts; the CHECKs are the last line behind the
-- zod schemas. Every grant is column-level where a login should not reach a column (password_hash, code_hmac,
-- id, role-bearing columns): the grants at the end say who may do what, and nobody gets TRUNCATE, REFERENCES
-- or TRIGGER. mjk_ssr gets nothing here (it reads only pub_* views, A§8).

-- A trusted extension: mjk_migrator owns the database, so it may create it without a superuser.
CREATE EXTENSION IF NOT EXISTS citext;

-- invite.created_by points at app_user, which needs invite for its own invite_id: the key is added below.
CREATE TABLE invite (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  -- HMAC-SHA256 of the normalised code (A§9): the code itself is never stored.
  code_hmac bytea NOT NULL UNIQUE CHECK (octet_length(code_hmac) = 32),
  created_by uuid,
  note text CHECK (char_length(note) <= 200),
  max_uses integer NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 1000),
  uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0 AND uses <= max_uses),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '14 days',
  used_at timestamptz, -- the last use
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  -- Normalised (lower-cased) by the contract before it gets here; citext makes the lookups case-blind anyway.
  email citext NOT NULL UNIQUE CHECK (char_length(email) BETWEEN 3 AND 254 AND email::text = lower(email::text)),
  email_verified_at timestamptz NOT NULL,
  -- ::text on purpose: ~ on citext is case-insensitive and would accept 'ABC'.
  handle citext NOT NULL UNIQUE CHECK (handle::text ~ '^[a-z0-9_]{3,30}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 50),
  password_hash text CHECK (password_hash IS NULL OR (password_hash ~ '^\$argon2id\$' AND char_length(password_hash) <= 200)),
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned', 'deleted')),
  banned_until timestamptz,
  ban_reason text CHECK (char_length(ban_reason) <= 1000),
  trusted_at timestamptz,
  age_confirmed_at timestamptz NOT NULL,
  terms_version text NOT NULL CHECK (char_length(terms_version) BETWEEN 1 AND 40),
  terms_accepted_at timestamptz NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
  invite_id uuid REFERENCES invite (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE invite ADD CONSTRAINT invite_created_by_fkey FOREIGN KEY (created_by) REFERENCES app_user (id) ON DELETE SET NULL;

-- id is sha256(token): the token itself is never stored. ref is the public handle for the session list.
CREATE TABLE session (
  id bytea PRIMARY KEY CHECK (octet_length(id) = 32),
  ref uuid NOT NULL UNIQUE DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  host text NOT NULL CHECK (host IN ('public', 'admin')),
  method text NOT NULL CHECK (method IN ('code', 'password', 'passkey')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  reauth_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at <= absolute_expires_at)
);
CREATE INDEX session_user_id_idx ON session (user_id);
CREATE INDEX session_expires_at_idx ON session (expires_at);
CREATE INDEX session_absolute_expires_at_idx ON session (absolute_expires_at);

CREATE TABLE email_code (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  email citext NOT NULL CHECK (char_length(email) <= 254),
  purpose text NOT NULL CHECK (purpose IN ('signup', 'signin', 'email_change', 'delete')),
  code_hmac bytea NOT NULL CHECK (octet_length(code_hmac) = 32),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  pending jsonb CHECK (pending IS NULL OR jsonb_typeof(pending) = 'object'),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_code_email_purpose_idx ON email_code (email, purpose, created_at DESC);
CREATE INDEX email_code_created_at_idx ON email_code (created_at);

CREATE TABLE auth_challenge (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  purpose text NOT NULL CHECK (purpose IN ('altcha', 'webauthn')),
  host text NOT NULL CHECK (host IN ('public', 'admin')),
  value_hash bytea NOT NULL UNIQUE CHECK (octet_length(value_hash) = 32),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_challenge_expires_at_idx ON auth_challenge (expires_at);

-- Keys are IP prefixes or hashed values, never raw addresses (A§9, A§13.2).
CREATE TABLE rate_limit (
  bucket text NOT NULL CHECK (bucket ~ '^[a-z0-9_]{1,40}$'),
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 100),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  count integer NOT NULL CHECK (count >= 0),
  PRIMARY KEY (bucket, key, window_start),
  CHECK (window_end > window_start)
);
CREATE INDEX rate_limit_window_end_idx ON rate_limit (window_end);

-- Append-only: bare actor and target ids (no foreign keys), so a deleted user's trail stays.
CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'moderator', 'admin', 'system')),
  action text NOT NULL CHECK (action ~ '^[a-z_.]{1,60}$'),
  target_kind text CHECK (target_kind ~ '^[a-z_]{1,40}$'),
  target_id uuid,
  detail jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail) = 'object')
);

CREATE TABLE content_ip_log (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid REFERENCES app_user (id) ON DELETE SET NULL,
  target_kind text NOT NULL CHECK (target_kind ~ '^[a-z_]{1,40}$'),
  target_id uuid NOT NULL,
  ip inet NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX content_ip_log_created_at_idx ON content_ip_log (created_at);

-- mjk_api
GRANT SELECT, INSERT ON app_user TO mjk_api;
GRANT UPDATE (email, email_verified_at, display_name, password_hash, role, status, banned_until, ban_reason, settings)
  ON app_user TO mjk_api;
GRANT SELECT, INSERT, DELETE ON session TO mjk_api;
GRANT UPDATE (expires_at, last_used_at) ON session TO mjk_api;
GRANT SELECT, INSERT, DELETE ON email_code TO mjk_api;
GRANT UPDATE (attempts, used_at) ON email_code TO mjk_api;
GRANT SELECT, INSERT ON auth_challenge TO mjk_api;
GRANT SELECT, INSERT ON invite TO mjk_api;
GRANT UPDATE (uses, used_at) ON invite TO mjk_api;
GRANT SELECT, INSERT, UPDATE ON rate_limit TO mjk_api;
GRANT SELECT, INSERT ON audit_log TO mjk_api;
GRANT INSERT ON content_ip_log TO mjk_api;

-- mjk_worker (purges and mail jobs): never password_hash or code_hmac.
GRANT SELECT (id, email, status, settings) ON app_user TO mjk_worker;
GRANT SELECT (id, email, purpose, expires_at, created_at) ON email_code TO mjk_worker;
GRANT DELETE ON email_code TO mjk_worker;
GRANT SELECT (expires_at, absolute_expires_at) ON session TO mjk_worker;
GRANT DELETE ON session TO mjk_worker;
GRANT SELECT (expires_at) ON auth_challenge TO mjk_worker;
GRANT DELETE ON auth_challenge TO mjk_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit TO mjk_worker;
GRANT SELECT (id, expires_at, used_at, uses, max_uses) ON invite TO mjk_worker;
GRANT DELETE ON invite TO mjk_worker;
GRANT SELECT (created_at) ON content_ip_log TO mjk_worker;
GRANT DELETE ON content_ip_log TO mjk_worker;
-- A§8 foresaw it: the purge and the delete-on-success mail jobs.
GRANT DELETE ON job TO mjk_worker;
GRANT INSERT ON audit_log TO mjk_worker;

-- migrate:down
REVOKE DELETE ON job FROM mjk_worker;
DROP TABLE content_ip_log;
DROP TABLE audit_log;
DROP TABLE rate_limit;
DROP TABLE auth_challenge;
DROP TABLE email_code;
DROP TABLE session;
ALTER TABLE invite DROP CONSTRAINT invite_created_by_fkey;
DROP TABLE app_user;
DROP TABLE invite;
DROP EXTENSION citext;
