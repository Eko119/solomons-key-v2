-- Rollback for 0007_motor_cortex.sql
DROP INDEX IF EXISTS idx_receipts_command;
DROP INDEX IF EXISTS idx_receipts_timestamp;
DROP TABLE IF EXISTS execution_receipts;
DROP INDEX IF EXISTS idx_cap_grants_agent;
DROP TABLE IF EXISTS capability_grants;
DROP TABLE IF EXISTS command_registry;
DROP TABLE IF EXISTS mcp_servers;
