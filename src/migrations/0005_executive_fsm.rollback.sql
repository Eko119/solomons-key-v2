-- Rollback Phase 11: Executive Function State Machine
-- Drop in reverse dependency order.

DROP TABLE IF EXISTS budget_ledger;
DROP TABLE IF EXISTS state_transitions;
DROP TABLE IF EXISTS execution_receipts;
DROP TABLE IF EXISTS task_dependencies;
DROP TABLE IF EXISTS task_nodes;
DROP TABLE IF EXISTS task_graphs;
