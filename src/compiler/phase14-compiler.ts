// Deterministic compiler: ProposalDiff → CompiledArtifact.
// Pure function — no file I/O, no side effects, no heuristics.
// Same input always produces identical output.
// Unknown op type throws immediately (fail-fast).

import type { ProposalDiff, CompiledArtifact } from './schema';
import type { ProposalOp, ColumnDef } from './ops';

// ── Name generation ───────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function transitionOpName(from: string, to: string): string {
  return `${capitalize(from)}To${capitalize(to)}`;
}

// ── TLA+ generation ───────────────────────────────────────────────────────────

function tlaOperatorBlock(from: string, to: string): string {
  const name = transitionOpName(from, to);
  return [
    `${name}(t) ==`,
    `  \\* TRANSITION state[t] = "${from}" => state'[t] = "${to}"`,
    `  /\\ state[t] = "${from}"`,
    `  /\\ state' = [state EXCEPT ![t] = "${to}"]`,
    `  /\\ UNCHANGED <<budget, attempt_count, lease_owner, lease_expires_at>>`,
  ].join('\n');
}

function tlaInvariantBlock(name: string, predicate: string): string {
  return `${name} ==\n  ${predicate}`;
}

// ── SQL generation ────────────────────────────────────────────────────────────

function sqlColumnDef(col: ColumnDef): string {
  const parts: string[] = [`  ${col.name} ${col.type}`];
  if (col.nullable === false || col.nullable === undefined && col.default === undefined) {
    // PRIMARY KEY implies NOT NULL — skip for simplicity; caller sets nullable
  }
  if (col.unique === true) parts[0] += ' UNIQUE';
  if (col.default !== null && col.default !== undefined) {
    const dflt = typeof col.default === 'string' ? `'${col.default}'` : String(col.default);
    parts[0] += ` DEFAULT ${dflt}`;
  }
  if (col.check) parts[0] += ` CHECK(${col.check})`;
  if (col.nullable === false) parts[0] += ' NOT NULL';
  return parts[0]!;
}

function sqlCreateTable(tableName: string, columns: ColumnDef[]): string {
  const cols = columns.map(sqlColumnDef).join(',\n');
  return `CREATE TABLE IF NOT EXISTS ${tableName} (\n${cols}\n);`;
}

function sqlAlterTableAdd(tableName: string, columns: ColumnDef[]): string {
  return columns
    .map(col => `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${sqlColumnDef(col).trim()};`)
    .join('\n');
}

function sqlAlterTableDrop(tableName: string, names: string[]): string {
  return names
    .map(name => `ALTER TABLE ${tableName} DROP COLUMN IF EXISTS ${name};`)
    .join('\n');
}

function sqlProjection(from: string, to: string): string {
  return `UPDATE task_nodes SET state='${to}' WHERE state='${from}'`;
}

function sqlAddCapability(name: string, description: string): string {
  return `INSERT OR IGNORE INTO capability_registry (name, description, status, created_at)\n` +
    `VALUES ('${name}', '${description}', 'ACTIVE', 0);`;
}

function sqlRevokeCapability(name: string): string {
  return `UPDATE capability_registry\n` +
    `SET status = 'REVOKED', revoked_at = 0\n` +
    `WHERE name = '${name}' AND status = 'ACTIVE';`;
}

// ── Per-operation compiler ────────────────────────────────────────────────────

function compileOp(op: ProposalOp): CompiledArtifact {
  switch (op.type) {
    case 'ADD_TRANSITION':
      return {
        sqlMigrations:     [],
        tlaSpecPatches:    [tlaOperatorBlock(op.from, op.to)],
        capabilityUpdates: [],
        projectionUpdates: [sqlProjection(op.from, op.to)],
      };

    case 'REMOVE_TRANSITION':
      return {
        sqlMigrations:     [],
        tlaSpecPatches:    [`REMOVE:${transitionOpName(op.from, op.to)}`],
        capabilityUpdates: [],
        projectionUpdates: [`REMOVE:${sqlProjection(op.from, op.to)}`],
      };

    case 'MODIFY_TRANSITION':
      // Modify = remove old operator + add updated one with same (from, to).
      return {
        sqlMigrations:     [],
        tlaSpecPatches:    [tlaOperatorBlock(op.from, op.to)],
        capabilityUpdates: [],
        projectionUpdates: [sqlProjection(op.from, op.to)],
      };

    case 'ADD_CONSTRAINT':
      return {
        sqlMigrations:     [],
        tlaSpecPatches:    [tlaInvariantBlock(op.name, op.predicate)],
        capabilityUpdates: [],
        projectionUpdates: [],
      };

    case 'REMOVE_CONSTRAINT':
      return {
        sqlMigrations:     [],
        tlaSpecPatches:    [`REMOVE_INVARIANT:${op.name}`],
        capabilityUpdates: [],
        projectionUpdates: [],
      };

    case 'ADD_TABLE':
      return {
        sqlMigrations:     [sqlCreateTable(op.tableName, [...op.columns])],
        tlaSpecPatches:    [],
        capabilityUpdates: [],
        projectionUpdates: [],
      };

    case 'MODIFY_TABLE': {
      const parts: string[] = [];
      if (op.addColumns && op.addColumns.length > 0) {
        parts.push(sqlAlterTableAdd(op.tableName, [...op.addColumns]));
      }
      if (op.dropColumns && op.dropColumns.length > 0) {
        parts.push(sqlAlterTableDrop(op.tableName, op.dropColumns));
      }
      return {
        sqlMigrations:     parts,
        tlaSpecPatches:    [],
        capabilityUpdates: [],
        projectionUpdates: [],
      };
    }

    case 'ADD_CAPABILITY':
      return {
        sqlMigrations:     [],
        tlaSpecPatches:    [],
        capabilityUpdates: [sqlAddCapability(op.name, op.description)],
        projectionUpdates: [],
      };

    case 'REVOKE_CAPABILITY':
      return {
        sqlMigrations:     [],
        tlaSpecPatches:    [],
        capabilityUpdates: [sqlRevokeCapability(op.name)],
        projectionUpdates: [],
      };

    default: {
      // TypeScript exhaustiveness — this branch is unreachable at compile time.
      const never: never = op;
      throw new Error(`Unknown ProposalOp: ${(never as { type: string }).type}`);
    }
  }
}

// ── Public compiler entry point ───────────────────────────────────────────────

export function compileProposal(diff: ProposalDiff): CompiledArtifact {
  const result: CompiledArtifact = {
    sqlMigrations:     [],
    tlaSpecPatches:    [],
    capabilityUpdates: [],
    projectionUpdates: [],
  };

  for (const op of diff.ops) {
    const part = compileOp(op);
    result.sqlMigrations.push(...part.sqlMigrations);
    result.tlaSpecPatches.push(...part.tlaSpecPatches);
    result.capabilityUpdates.push(...part.capabilityUpdates);
    result.projectionUpdates.push(...part.projectionUpdates);
  }

  return result;
}
