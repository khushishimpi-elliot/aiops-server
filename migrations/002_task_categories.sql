-- Migration 002: Task category tracking
-- Apply: psql $DATABASE_URL -f migrations/002_task_categories.sql

BEGIN;

CREATE TABLE usage_categories (
    id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         bigint      NOT NULL REFERENCES users(id),
    device_id       bigint      NOT NULL REFERENCES devices(id),
    date            date        NOT NULL,
    category        text        NOT NULL,
    session_count   int         NOT NULL DEFAULT 0 CHECK (session_count >= 0),
    idempotency_key text        NOT NULL,
    recorded_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (idempotency_key)
);

CREATE INDEX usage_categories_user_date ON usage_categories(user_id, date DESC);
CREATE INDEX usage_categories_date      ON usage_categories(date DESC);
CREATE INDEX usage_categories_device    ON usage_categories(device_id, date DESC);

COMMIT;
