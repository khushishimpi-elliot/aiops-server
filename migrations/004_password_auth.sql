-- Migration 004 — password-based enrollment auth
-- Adds password_hash to users so developers can self-register via CLI
-- without requiring OTP email delivery.

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;

INSERT INTO schema_migrations(version) VALUES ('004_password_auth')
ON CONFLICT DO NOTHING;

COMMIT;
