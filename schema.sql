-- AIOps Server — Postgres 15+, designed for Neon free tier
-- Apply: psql $DATABASE_URL -f schema.sql
-- Runs in a single transaction — all or nothing.

BEGIN;

-- Extensions
CREATE EXTENSION IF NOT EXISTS citext;    -- case-insensitive text (email comparisons)
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid(), pgp_sym_encrypt if needed

-- ---------------------------------------------------------------------------
-- teams
-- ---------------------------------------------------------------------------
CREATE TABLE teams (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- domains  (allowed email domains per team)
-- ---------------------------------------------------------------------------
CREATE TABLE domains (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    team_id     bigint      NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    domain      citext      NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (domain)
);

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    team_id     bigint      NOT NULL REFERENCES teams(id),
    email       citext      NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz,                         -- soft-delete; purge_user() fills this
    UNIQUE (email)
);

CREATE INDEX users_team ON users(team_id);

-- ---------------------------------------------------------------------------
-- devices  (one device can enroll multiple times across users, UNLESS revoked)
-- ---------------------------------------------------------------------------
CREATE TABLE devices (
    id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       bigint      NOT NULL REFERENCES users(id),
    machine_id    text        NOT NULL,   -- SHA-256 of hardware fingerprint, never raw
    label         text,                  -- user-supplied friendly name
    agent_version text,                  -- semver string from the agent, e.g. "1.2.0"
    last_seen_at  timestamptz,           -- updated on every successful telemetry POST
    status        text        NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'revoked')),
    enrolled_at   timestamptz NOT NULL DEFAULT now()
);

-- Once revoked, that machine_id can NEVER re-enroll (even under a new user).
-- A partial unique index covers only revoked rows; active rows are unrestricted.
CREATE UNIQUE INDEX devices_revoked_machine_id ON devices(machine_id) WHERE status = 'revoked';
CREATE INDEX devices_user ON devices(user_id);

-- ---------------------------------------------------------------------------
-- usage  — the hot table; NO text columns that could hold prompt/response content
-- ---------------------------------------------------------------------------
CREATE TABLE usage (
    id                   bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id              bigint      NOT NULL REFERENCES users(id),
    device_id            bigint      NOT NULL REFERENCES devices(id),
    date                 date        NOT NULL,
    tool                 text        NOT NULL,   -- "claude_code", "cursor", etc.
    model                text        NOT NULL,   -- "claude-sonnet-4-5", etc.
    input_tokens         bigint      NOT NULL CHECK (input_tokens  >= 0),
    output_tokens        bigint      NOT NULL CHECK (output_tokens >= 0),
    cache_read_tokens    bigint      NOT NULL DEFAULT 0 CHECK (cache_read_tokens  >= 0),
    cache_write_tokens   bigint      NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
    cost_millicents      bigint      NOT NULL CHECK (cost_millicents >= 0),  -- 1/1000 of a cent
    idempotency_key      text        NOT NULL,   -- agent-generated; hash(user+device+date+tool+model)
    recorded_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (idempotency_key)
);

CREATE INDEX usage_user_date  ON usage(user_id,  date DESC);
CREATE INDEX usage_date       ON usage(date DESC);
CREATE INDEX usage_device     ON usage(device_id, date DESC);

-- ---------------------------------------------------------------------------
-- otp_requests  (rate-limit check + single-use enforcement happen here)
-- ---------------------------------------------------------------------------
CREATE TABLE otp_requests (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email       citext      NOT NULL,
    code_hash   text        NOT NULL,   -- bcrypt hash; raw code is never stored
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,            -- set on successful verify; NULL = not yet used
    ip_address  inet,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX otp_email_created ON otp_requests(email, created_at DESC);

-- ---------------------------------------------------------------------------
-- pricing  (versioned; cost engine looks up effective_to IS NULL for current price)
-- ---------------------------------------------------------------------------
CREATE TABLE pricing (
    id                              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tool                            text        NOT NULL,
    model                           text        NOT NULL,
    input_millicents_per_1k         bigint      NOT NULL CHECK (input_millicents_per_1k        >= 0),
    output_millicents_per_1k        bigint      NOT NULL CHECK (output_millicents_per_1k       >= 0),
    cache_read_millicents_per_1k    bigint      NOT NULL DEFAULT 0 CHECK (cache_read_millicents_per_1k  >= 0),
    cache_write_millicents_per_1k   bigint      NOT NULL DEFAULT 0 CHECK (cache_write_millicents_per_1k >= 0),
    effective_from                  timestamptz NOT NULL DEFAULT now(),
    effective_to                    timestamptz,         -- NULL = currently active
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- Exactly one active price row per (tool, model)
CREATE UNIQUE INDEX pricing_current ON pricing(tool, model) WHERE effective_to IS NULL;

-- ---------------------------------------------------------------------------
-- audit_log  (append-only; triggers below enforce immutability)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor       citext      NOT NULL,   -- admin email that triggered the action
    action      text        NOT NULL,   -- e.g. "enroll_device", "purge_user", "login"
    target_type text,                   -- e.g. "user", "device", "domain"
    target_id   bigint,
    detail      jsonb,                  -- freeform context (no PII in here by convention)
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_actor     ON audit_log(actor, created_at DESC);
CREATE INDEX audit_target    ON audit_log(target_type, target_id, created_at DESC);
CREATE INDEX audit_created   ON audit_log(created_at DESC);

-- Immutability: nobody — not even a direct DB user — can UPDATE or DELETE audit rows.
CREATE OR REPLACE FUNCTION audit_log_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_log rows are immutable (action=%, id=%)', TG_OP, OLD.id;
END;
$$;

CREATE TRIGGER audit_log_no_update
    BEFORE UPDATE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TRIGGER audit_log_no_delete
    BEFORE DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- ---------------------------------------------------------------------------
-- admin_sessions
-- ---------------------------------------------------------------------------
CREATE TABLE admin_sessions (
    id          text        PRIMARY KEY,                 -- cryptographically random token
    admin_email citext      NOT NULL,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_sessions_expires ON admin_sessions(expires_at);

-- ---------------------------------------------------------------------------
-- purge_user()  — GDPR / offboarding
--
-- Decision documented here: devices rows are left as 'revoked', NOT deleted.
-- Rationale: deleting them would allow the same machine_id to re-enroll,
-- defeating the permanent-revocation guarantee. machine_id is a hash (not raw
-- hardware data), and the user's email is overwritten below, so no PII is
-- retained in the devices table after purge.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION purge_user(p_user_id bigint, p_actor citext)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    -- Revoke all active devices (preserves machine_id hash for permanent block)
    UPDATE devices
       SET status = 'revoked'
     WHERE user_id = p_user_id
       AND status  = 'active';

    -- Overwrite the email so the user cannot be identified by it
    UPDATE users
       SET deleted_at = now(),
           email      = 'deleted-' || p_user_id || '@deleted.invalid'
     WHERE id = p_user_id;

    -- Immutable audit trail
    INSERT INTO audit_log(actor, action, target_type, target_id, detail)
    VALUES (p_actor, 'purge_user', 'user', p_user_id,
            jsonb_build_object('note', 'gdpr_or_offboard'));
END;
$$;

COMMIT;
