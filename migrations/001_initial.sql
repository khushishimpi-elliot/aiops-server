-- Migration 001 — initial schema
-- This is a copy of schema.sql tracked as the first migration.
-- Future migrations: create 002_*.sql, 003_*.sql, etc. and record them
-- in the schema_migrations table (added at the bottom of this file).

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE teams (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE domains (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    team_id     bigint      NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    domain      citext      NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (domain)
);

CREATE TABLE users (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    team_id     bigint      NOT NULL REFERENCES teams(id),
    email       citext      NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz,
    UNIQUE (email)
);

CREATE INDEX users_team ON users(team_id);

CREATE TABLE devices (
    id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       bigint      NOT NULL REFERENCES users(id),
    machine_id    text        NOT NULL,
    label         text,
    agent_version text,
    last_seen_at  timestamptz,
    status        text        NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'revoked')),
    enrolled_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX devices_revoked_machine_id ON devices(machine_id) WHERE status = 'revoked';
CREATE INDEX devices_user ON devices(user_id);

CREATE TABLE usage (
    id                   bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id              bigint      NOT NULL REFERENCES users(id),
    device_id            bigint      NOT NULL REFERENCES devices(id),
    date                 date        NOT NULL,
    tool                 text        NOT NULL,
    model                text        NOT NULL,
    input_tokens         bigint      NOT NULL CHECK (input_tokens  >= 0),
    output_tokens        bigint      NOT NULL CHECK (output_tokens >= 0),
    cache_read_tokens    bigint      NOT NULL DEFAULT 0 CHECK (cache_read_tokens  >= 0),
    cache_write_tokens   bigint      NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
    cost_millicents      bigint      NOT NULL CHECK (cost_millicents >= 0),
    idempotency_key      text        NOT NULL,
    recorded_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (idempotency_key)
);

CREATE INDEX usage_user_date  ON usage(user_id,  date DESC);
CREATE INDEX usage_date       ON usage(date DESC);
CREATE INDEX usage_device     ON usage(device_id, date DESC);

CREATE TABLE otp_requests (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email       citext      NOT NULL,
    code_hash   text        NOT NULL,
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    ip_address  inet,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX otp_email_created ON otp_requests(email, created_at DESC);

CREATE TABLE pricing (
    id                              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tool                            text        NOT NULL,
    model                           text        NOT NULL,
    input_millicents_per_1k         bigint      NOT NULL CHECK (input_millicents_per_1k        >= 0),
    output_millicents_per_1k        bigint      NOT NULL CHECK (output_millicents_per_1k       >= 0),
    cache_read_millicents_per_1k    bigint      NOT NULL DEFAULT 0 CHECK (cache_read_millicents_per_1k  >= 0),
    cache_write_millicents_per_1k   bigint      NOT NULL DEFAULT 0 CHECK (cache_write_millicents_per_1k >= 0),
    effective_from                  timestamptz NOT NULL DEFAULT now(),
    effective_to                    timestamptz,
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE UNIQUE INDEX pricing_current ON pricing(tool, model) WHERE effective_to IS NULL;

CREATE TABLE audit_log (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor       citext      NOT NULL,
    action      text        NOT NULL,
    target_type text,
    target_id   bigint,
    detail      jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_actor     ON audit_log(actor, created_at DESC);
CREATE INDEX audit_target    ON audit_log(target_type, target_id, created_at DESC);
CREATE INDEX audit_created   ON audit_log(created_at DESC);

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

CREATE TABLE admin_sessions (
    id          text        PRIMARY KEY,
    admin_email citext      NOT NULL,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_sessions_expires ON admin_sessions(expires_at);

CREATE OR REPLACE FUNCTION purge_user(p_user_id bigint, p_actor citext)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    UPDATE devices SET status = 'revoked' WHERE user_id = p_user_id AND status = 'active';
    UPDATE users
       SET deleted_at = now(),
           email      = 'deleted-' || p_user_id || '@deleted.invalid'
     WHERE id = p_user_id;
    INSERT INTO audit_log(actor, action, target_type, target_id, detail)
    VALUES (p_actor, 'purge_user', 'user', p_user_id,
            jsonb_build_object('note', 'gdpr_or_offboard'));
END;
$$;

-- Migration tracking table (used by future migrations)
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     text        PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations(version) VALUES ('001_initial');

COMMIT;
