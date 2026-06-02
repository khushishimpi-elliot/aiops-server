-- Migration 003: API tokens for npm agent enrollment
-- Apply: psql $DATABASE_URL -f migrations/003_api_tokens.sql

BEGIN;

ALTER TABLE devices ADD COLUMN api_token_hash text;
CREATE UNIQUE INDEX devices_api_token_hash ON devices(api_token_hash) WHERE api_token_hash IS NOT NULL;

INSERT INTO schema_migrations(version) VALUES ('003_api_tokens');

COMMIT;
