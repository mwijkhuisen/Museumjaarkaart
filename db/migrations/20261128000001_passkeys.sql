-- migrate:up
-- P2b (A§8, A§9): passkeys and the opaque WebAuthn user handle. A passkey row holds the public half only
-- (credential id, COSE public key, signature counter); the user handle is 16 random bytes that never derive from
-- the email, the handle or a time, so an authenticator learns nothing about the account. The CHECKs match the
-- limits in packages/contracts/src/passkey.ts and are the last line behind the zod schemas.

ALTER TABLE app_user
  ADD COLUMN webauthn_user_id bytea NOT NULL UNIQUE DEFAULT uuid_send(gen_random_uuid())
    CHECK (octet_length(webauthn_user_id) = 16);
-- 16 random bytes, 122 bits from the CSPRNG (a v4 uuid's version and variant bits are fixed). The default is
-- volatile, so ADD COLUMN computes one per existing row. No login may UPDATE it, and it is never the email, the
-- handle or a time (A§9 Q2).

-- ref is the public handle for the member's passkey list (like session.ref): credential_id never leaves the api.
CREATE TABLE passkey (
  credential_id bytea PRIMARY KEY CHECK (octet_length(credential_id) BETWEEN 1 AND 1023),
  ref uuid NOT NULL UNIQUE DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  public_key bytea NOT NULL CHECK (octet_length(public_key) BETWEEN 1 AND 2048),
  sign_count bigint NOT NULL DEFAULT 0 CHECK (sign_count BETWEEN 0 AND 4294967295),
  transports text[] NOT NULL DEFAULT '{}' CHECK (
    cardinality(transports) <= 8
    AND (cardinality(transports) = 0 OR array_ndims(transports) = 1)
    AND array_position(transports, NULL) IS NULL
    AND transports <@ ARRAY['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']::text[]
  ),
  backed_up boolean NOT NULL,
  name text CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 50),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX passkey_user_id_idx ON passkey (user_id, created_at);

-- mjk_api: the sign-in and the member's /me/passkeys routes. mjk_worker and mjk_ssr: nothing (a user delete
-- cascades as the table owner). mjk_backup reads it through pg_read_all_data.
GRANT SELECT, INSERT, DELETE ON passkey TO mjk_api;
GRANT UPDATE (name, sign_count, backed_up, last_used_at) ON passkey TO mjk_api;

-- migrate:down
DROP TABLE passkey;
ALTER TABLE app_user DROP COLUMN webauthn_user_id;
