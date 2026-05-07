// Deterministic task scheduler.
// Ordering (strictly applied, no randomness):
//   1. priority DESC
//   2. dependency depth ASC  (shallowest = most ancestral first)
//   3. created_at ASC
//   4. task_id ASC           (lexicographic tiebreaker — fully deterministic)

import { dbGetRunnablePending } from './db';
import { computeNodeDepths } from './dag';
import { reclaimExpiredLeases } from './lease';
import type { TaskNode } from './schema';

export interface SchedulerOptions {
  limit?: number; // max tasks to return (default: unlimited)
}

// Returns runnable PENDING tasks in the canonical deterministic order.
// Reclaims expired leases before selection so recovered tasks are eligible.
export function selectRunnableTasks(now: number, opts: SchedulerOptions = {}): TaskNode[] {
  // Step 0: reclaim expired leases — expired EXECUTING tasks become PENDING/CANCELLED.
  reclaimExpiredLeases(now);

  // Step 1: fetch all PENDING tasks whose dependencies are all COMPLETED
  //         and which have no active lease.
  const candidates = dbGetRunnablePending(now);
  if (candidates.length === 0) return [];

  // Step 2: compute depth per task (longest path from any root in its graph).
  // Group by graph_id to amortize depth computation per graph.
  const graphIds    = [...new Set(candidates.map(n => n.graph_id))];
  const depthByNode = new Map<string, number>();
  for (const graphId of graphIds) {
    const depths = computeNodeDepths(graphId);
    for (const [id, depth] of depths) depthByNode.set(id, depth);
  }

  // Step 3: sort deterministically.
  const sorted = [...candidates].sort((a, b) => {
    // priority DESC
    if (b.priority !== a.priority) return b.priority - a.priority;
    // depth ASC
    const da = depthByNode.get(a.id) ?? 0;
    const db_ = depthByNode.get(b.id) ?? 0;
    if (da !== db_) return da - db_;
    // created_at ASC
    if (a.created_at !== b.created_at) return a.created_at - b.created_at;
    // task_id ASC (lexicographic, fully deterministic)
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return opts.limit !== undefined ? sorted.slice(0, opts.limit) : sorted;
}
