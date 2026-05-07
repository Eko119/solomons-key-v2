// Startup recovery engine.
// Reconstructs system state from SQLite only — no memory trust.
//
// EXECUTING tasks on restart:
//   • If a receipt for the current effect_id exists → execution completed
//     but state transition did not persist (crash after receipt, before VERIFYING).
//     Resume: EXECUTING → VERIFYING → COMPLETED/FAILED.
//   • Otherwise → execution was interrupted. Resume: EXECUTING → FAILED → PENDING/CANCELLED.
//
// VERIFYING tasks on restart:
//   • Find latest receipt → COMPLETED if exit_code=0, else FAILED → PENDING/CANCELLED.

import { dbGetIncompleteNodes, dbReleaseLease, dbGetBudget } from './db';
import { getLatestReceiptForTask } from './receipts';
import { applyTransition } from './state-machine';

export function recoverOnStartup(now: number): { recovered: number; details: string[] } {
  const incomplete = dbGetIncompleteNodes();
  const details: string[] = [];
  let recovered = 0;

  for (const task of incomplete) {
    if (task.state === 'EXECUTING') {
      const receipt = getLatestReceiptForTask(task.id);

      if (receipt && receipt.effect_id === task.effect_id) {
        // Execution completed before crash — resume from VERIFYING.
        applyTransition(task.id, 'EXECUTING', 'VERIFYING', now);
        if (receipt.exit_code === 0) {
          applyTransition(task.id, 'VERIFYING', 'COMPLETED', now);
          details.push(`${task.id}: EXECUTING → VERIFYING → COMPLETED (receipt recovered)`);
        } else {
          applyTransition(task.id, 'VERIFYING', 'FAILED', now);
          routeFailedTask(task.id, now, details);
        }
      } else {
        // Execution was interrupted — transition directly to FAILED.
        applyTransition(task.id, 'EXECUTING', 'FAILED', now);
        details.push(`${task.id}: EXECUTING → FAILED (interrupted, no receipt)`);
        routeFailedTask(task.id, now, details);
      }

      dbReleaseLease(task.id, now);
      recovered++;
    } else if (task.state === 'VERIFYING') {
      const receipt = getLatestReceiptForTask(task.id);

      if (receipt && receipt.exit_code === 0) {
        applyTransition(task.id, 'VERIFYING', 'COMPLETED', now);
        details.push(`${task.id}: VERIFYING → COMPLETED (receipt exit_code=0)`);
      } else {
        applyTransition(task.id, 'VERIFYING', 'FAILED', now);
        details.push(`${task.id}: VERIFYING → FAILED (no receipt or non-zero exit_code)`);
        routeFailedTask(task.id, now, details);
      }

      dbReleaseLease(task.id, now);
      recovered++;
    }
  }

  if (recovered > 0) {
    console.info(`[efsm:recovery] recovered ${recovered} incomplete task(s)`);
    for (const d of details) console.debug(`[efsm:recovery]   ${d}`);
  }

  return { recovered, details };
}

function routeFailedTask(taskId: string, now: number, details: string[]): void {
  const budget = dbGetBudget(taskId);
  if (budget && budget.remaining_budget > 0) {
    applyTransition(taskId, 'FAILED', 'PENDING', now);
    details.push(`${taskId}: FAILED → PENDING (budget=${budget.remaining_budget})`);
  } else {
    applyTransition(taskId, 'FAILED', 'CANCELLED', now);
    details.push(`${taskId}: FAILED → CANCELLED (budget exhausted)`);
  }
}
