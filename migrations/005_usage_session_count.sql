-- 005: store the agent-reported session count on usage rows.
-- Before this, the per-aggregate `sessions` value was discarded and the
-- dashboard approximated session counts with days_active / COUNT(*).
ALTER TABLE usage ADD COLUMN IF NOT EXISTS session_count int NOT NULL DEFAULT 0;
