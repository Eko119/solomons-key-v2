// DAG validator for task_graphs.
// Validates: acyclic, no orphan nodes, no duplicate edges, all nodes connected.
// Also provides deterministic depth computation for scheduler ordering.

import { dbGetNodesByGraph, dbGetDepsForGraph } from './db';
import type { TaskDependency } from './schema';

// ── Error type ───────────────────────────────────────────────────────────────

export class DagValidationError extends Error {
  readonly code = 'DAG_INVALID' as const;
  constructor(reason: string) {
    super(`DAG validation failed: ${reason}`);
    this.name = 'DagValidationError';
  }
}

// ── Internal graph structure ─────────────────────────────────────────────────

interface AdjacencyGraph {
  nodes:    ReadonlySet<string>;
  children: ReadonlyMap<string, readonly string[]>; // parent → children
  parents:  ReadonlyMap<string, readonly string[]>; // child  → parents
}

function buildAdjacency(
  nodeIds: readonly string[],
  deps:    readonly TaskDependency[],
): AdjacencyGraph {
  const nodes    = new Set(nodeIds);
  const children = new Map<string, string[]>();
  const parents  = new Map<string, string[]>();

  for (const id of nodeIds) {
    children.set(id, []);
    parents.set(id, []);
  }

  for (const dep of deps) {
    if (!nodes.has(dep.parent_task_id) || !nodes.has(dep.child_task_id)) {
      throw new DagValidationError(
        `dependency references node outside graph: ` +
        `${dep.parent_task_id} → ${dep.child_task_id}`,
      );
    }
    children.get(dep.parent_task_id)!.push(dep.child_task_id);
    parents.get(dep.child_task_id)!.push(dep.parent_task_id);
  }

  return { nodes, children, parents };
}

// ── Cycle detection (DFS colouring) ─────────────────────────────────────────
// white = unvisited, gray = on current path, black = fully processed

type Colour = 'white' | 'gray' | 'black';

function detectCycle(g: AdjacencyGraph): string | null {
  const colour = new Map<string, Colour>();
  for (const id of g.nodes) colour.set(id, 'white');

  function dfs(id: string): string | null {
    colour.set(id, 'gray');
    for (const child of g.children.get(id) ?? []) {
      if (colour.get(child) === 'gray') return `${id} → ${child}`;
      if (colour.get(child) === 'white') {
        const cycle = dfs(child);
        if (cycle) return cycle;
      }
    }
    colour.set(id, 'black');
    return null;
  }

  for (const id of g.nodes) {
    if (colour.get(id) === 'white') {
      const cycle = dfs(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

// ── Connectivity: all nodes reachable from root(s) ───────────────────────────
// Root nodes are those with no parents in the dependency graph.

function findOrphans(g: AdjacencyGraph): string[] {
  const roots: string[] = [];
  for (const id of g.nodes) {
    if ((g.parents.get(id)?.length ?? 0) === 0) roots.push(id);
  }

  const reachable = new Set<string>();
  const queue     = [...roots];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const child of g.children.get(id) ?? []) queue.push(child);
  }

  return [...g.nodes].filter(id => !reachable.has(id));
}

// ── Public: full DAG validation ──────────────────────────────────────────────

export function validateDag(graphId: string): void {
  const nodes = dbGetNodesByGraph(graphId);
  if (nodes.length === 0) {
    throw new DagValidationError('graph has no nodes');
  }

  const deps = dbGetDepsForGraph(graphId);
  const g    = buildAdjacency(nodes.map(n => n.id), deps);

  // Duplicate edges are prevented by the PRIMARY KEY on task_dependencies,
  // so we only need to validate the structural properties.

  const cycle = detectCycle(g);
  if (cycle) throw new DagValidationError(`cycle detected: ${cycle}`);

  const orphans = findOrphans(g);
  if (orphans.length > 0) {
    throw new DagValidationError(`orphan nodes (unreachable from roots): ${orphans.join(', ')}`);
  }
}

// ── Public: depth computation for scheduler ordering ────────────────────────
// Returns the longest-path depth of each node from any root.
// Computed via topological sort (Kahn's algorithm) — O(V+E).

export function computeNodeDepths(graphId: string): Map<string, number> {
  const nodes   = dbGetNodesByGraph(graphId);
  const deps    = dbGetDepsForGraph(graphId);
  const nodeIds = nodes.map(n => n.id);

  const inDegree  = new Map<string, number>();
  const outEdges  = new Map<string, string[]>();
  const depths    = new Map<string, number>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    outEdges.set(id, []);
    depths.set(id, 0);
  }

  for (const dep of deps) {
    inDegree.set(dep.child_task_id, (inDegree.get(dep.child_task_id) ?? 0) + 1);
    outEdges.get(dep.parent_task_id)!.push(dep.child_task_id);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  while (queue.length > 0) {
    const id    = queue.shift()!;
    const depth = depths.get(id)!;

    for (const child of outEdges.get(id) ?? []) {
      // Longest-path: update child depth only if this path is deeper.
      const childDepth = depths.get(child) ?? 0;
      if (depth + 1 > childDepth) depths.set(child, depth + 1);

      const remaining = (inDegree.get(child) ?? 1) - 1;
      inDegree.set(child, remaining);
      if (remaining === 0) queue.push(child);
    }
  }

  return depths;
}
