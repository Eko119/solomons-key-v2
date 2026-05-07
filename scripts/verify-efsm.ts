#!/usr/bin/env npx ts-node
/**
 * Static formal-verification gate.
 *
 * Extracts state-transition signatures from two sources:
 *   1. TLA+ spec  — formal_specs/efsm.tla   (abstract model)
 *   2. SQL projections — src/efsm/state-machine.ts TRANSITION_SQL_PROJECTIONS
 *      (concrete implementation contract)
 *
 * Extraction is regex/string-slicing ONLY. No AST parsers, no TLA+ grammar,
 * no SQL semantic evaluation.
 *
 * Normalization applied to both sides before comparison:
 *   - trim whitespace
 *   - collapse runs of whitespace to single space
 *   - strip surrounding single/double quotes from state names
 *   - uppercase state names
 *
 * A Transition is { pre: string; action: string; post: string }.
 * action is always "state_update" (both sides).
 *
 * PASS  — all TLA+ transitions have an exact matching SQL transition, 1:1.
 * FAIL  — any mismatch, missing, or extra transition; exits with code 1.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────────

interface Transition {
  pre:    string;
  action: string;
  post:   string;
}

// ── Normalization ─────────────────────────────────────────────────────────────

function normalizeState(raw: string): string {
  return raw.replace(/['"]/g, '').trim().toUpperCase();
}

function transitionKey(t: Transition): string {
  return `${t.pre}|${t.action}|${t.post}`;
}

// ── TLA+ extraction ──────────────────────────────────────────────────────────
// Matches lines of the form:
//   \* TRANSITION state[t] = "PRE" => state'[t] = "POST"

const TLA_REGEX = /\\?\*\s+TRANSITION\s+state\[t\]\s*=\s*"([^"]+)"\s*=>\s*state'\[t\]\s*=\s*"([^"]+)"/g;

function extractTlaTransitions(src: string): Transition[] {
  const results: Transition[] = [];
  let m: RegExpExecArray | null;
  while ((m = TLA_REGEX.exec(src)) !== null) {
    results.push({
      pre:    normalizeState(m[1]!),
      action: 'state_update',
      post:   normalizeState(m[2]!),
    });
  }
  return results;
}

// ── SQL projection extraction ─────────────────────────────────────────────────
// Matches string literals of the form (inside TRANSITION_SQL_PROJECTIONS array):
//   "UPDATE task_nodes SET state='POST' WHERE state='PRE'"
// or with double-quoted state names.

const SQL_REGEX = /UPDATE\s+task_nodes\s+SET\s+state\s*=\s*['"]([^'"]+)['"]\s+WHERE\s+state\s*=\s*['"]([^'"]+)['"]/gi;

function extractSqlTransitions(src: string): Transition[] {
  // Only scan inside the TRANSITION_SQL_PROJECTIONS array literal.
  const blockStart = src.indexOf('TRANSITION_SQL_PROJECTIONS');
  if (blockStart === -1) {
    throw new Error('TRANSITION_SQL_PROJECTIONS not found in state-machine.ts');
  }
  // Find the matching closing bracket of the array.
  const arrStart = src.indexOf('[', blockStart);
  if (arrStart === -1) {
    throw new Error('TRANSITION_SQL_PROJECTIONS array opening bracket not found');
  }
  let depth = 0;
  let arrEnd = arrStart;
  for (let i = arrStart; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (depth === 0) { arrEnd = i; break; } }
  }
  const block = src.slice(arrStart, arrEnd + 1);

  const results: Transition[] = [];
  let m: RegExpExecArray | null;
  SQL_REGEX.lastIndex = 0;
  while ((m = SQL_REGEX.exec(block)) !== null) {
    results.push({
      pre:    normalizeState(m[2]!), // WHERE state = 'PRE'
      action: 'state_update',
      post:   normalizeState(m[1]!), // SET state = 'POST'
    });
  }
  return results;
}

// ── Main comparison ───────────────────────────────────────────────────────────

function main(): void {
  const root = resolve(__dirname, '..');

  // VERIFY_TLA_PATH / VERIFY_SM_PATH may be set by the bootloader to point at
  // staged files (*.staged.tla / *.staged.ts) before committing to production.
  const tlaPath = process.env['VERIFY_TLA_PATH'] ?? resolve(root, 'formal_specs', 'efsm.tla');
  const smPath  = process.env['VERIFY_SM_PATH']  ?? resolve(root, 'src', 'efsm', 'state-machine.ts');

  let tlaSrc: string;
  let smSrc: string;
  try {
    tlaSrc = readFileSync(tlaPath, 'utf8');
  } catch (e: unknown) {
    console.error(`[verify-efsm] Cannot read TLA+ spec at ${tlaPath}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  try {
    smSrc = readFileSync(smPath, 'utf8');
  } catch (e: unknown) {
    console.error(`[verify-efsm] Cannot read state-machine.ts at ${smPath}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const tlaTransitions = extractTlaTransitions(tlaSrc);
  const sqlTransitions = extractSqlTransitions(smSrc);

  if (tlaTransitions.length === 0) {
    console.error('[verify-efsm] FAIL: No TLA+ transitions extracted — check TRANSITION comment format');
    process.exit(1);
  }
  if (sqlTransitions.length === 0) {
    console.error('[verify-efsm] FAIL: No SQL transitions extracted — check TRANSITION_SQL_PROJECTIONS format');
    process.exit(1);
  }

  const tlaKeys = new Set(tlaTransitions.map(transitionKey));
  const sqlKeys = new Set(sqlTransitions.map(transitionKey));

  const missingFromSql: string[] = [];
  const extraInSql:     string[] = [];

  for (const k of tlaKeys) {
    if (!sqlKeys.has(k)) missingFromSql.push(k);
  }
  for (const k of sqlKeys) {
    if (!tlaKeys.has(k)) extraInSql.push(k);
  }

  const failed = missingFromSql.length > 0 || extraInSql.length > 0;

  if (failed) {
    console.error('[verify-efsm] FAIL: transition mismatch detected');
    if (missingFromSql.length > 0) {
      console.error('\n  TLA+ transitions missing from SQL projections:');
      for (const k of missingFromSql) {
        const [pre, , post] = k.split('|');
        console.error(`    MISMATCH  TLA pre=${pre}  post=${post}  SQL=<none>`);
      }
    }
    if (extraInSql.length > 0) {
      console.error('\n  SQL projections missing from TLA+ spec:');
      for (const k of extraInSql) {
        const [pre, , post] = k.split('|');
        console.error(`    MISMATCH  SQL pre=${pre}  post=${post}  TLA=<none>`);
      }
    }
    console.error(`\n  TLA+: ${tlaTransitions.length} transitions`);
    console.error(`  SQL:  ${sqlTransitions.length} transitions`);
    process.exit(1);
  }

  // All pass.
  console.log(`[verify-efsm] PASS: ${tlaTransitions.length} transitions verified`);
  for (const t of tlaTransitions) {
    console.log(`  OK  ${t.pre} → ${t.post}`);
  }
  process.exit(0);
}

main();
