-- Rollback for 0006_topology_evolution.sql
DROP INDEX IF EXISTS idx_membership_concept;
DROP TABLE IF EXISTS concept_membership;
DROP INDEX IF EXISTS idx_lineage_parent;
DROP TABLE IF EXISTS concept_lineage;
DROP INDEX IF EXISTS idx_concept_split_candidates;
DROP INDEX IF EXISTS idx_concept_agent;
DROP TABLE IF EXISTS concept_nodes;
