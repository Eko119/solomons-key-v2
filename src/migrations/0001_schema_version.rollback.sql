-- DB-1 rollback.
-- Removes ONLY the schema_version table. Does NOT drop the feature tables
-- (sessions, memories, etc.) because they may hold production data that
-- predates this migration system. To wipe everything, delete the DB file
-- directly instead of running this rollback.

DROP TABLE IF EXISTS schema_version;
