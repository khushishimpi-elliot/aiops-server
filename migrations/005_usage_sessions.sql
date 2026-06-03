-- Migration 005: store per-aggregate session and turn counts on usage rows.
-- The agent already sends `sessions` and `total_turns` per daily aggregate, but
-- the usage table had no place to keep them, so the dashboard faked session
-- counts (COUNT(*) of category-rows). These columns let us store and SUM the
-- real values.
-- Apply: python run_migration.py migrations/005_usage_sessions.sql
--    or: psql $DATABASE_URL -f migrations/005_usage_sessions.sql

BEGIN;

ALTER TABLE usage ADD COLUMN IF NOT EXISTS sessions    int NOT NULL DEFAULT 0 CHECK (sessions >= 0);
ALTER TABLE usage ADD COLUMN IF NOT EXISTS total_turns int NOT NULL DEFAULT 0 CHECK (total_turns >= 0);

COMMIT;
