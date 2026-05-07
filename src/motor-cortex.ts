'use strict';

import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import * as nodePath from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { getDb } from './db';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_STDOUT_BYTES    = 1_048_576;  // 1 MiB
export const MAX_STDERR_BYTES    = 262_144;    // 256 KiB
export const MAX_EXECUTION_MS    = 60_000;     // default max per execution
const        SIGTERM_GRACE_MS    = 5_000;      // between SIGTERM and SIGKILL

// ─────────────────────────────────────────────────────────────────────────────
// ERRORS
// ─────────────────────────────────────────────────────────────────────────────

export class MotorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MotorError';
    this.code = code;
  }
}

export class SandboxError extends MotorError {
  constructor(message: string) { super('SANDBOX_ESCAPE', message); this.name = 'SandboxError'; }
}

export class CapabilityError extends MotorError {
  constructor(message: string) { super('CAPABILITY_DENIED', message); this.name = 'CapabilityError'; }
}

// ─────────────────────────────────────────────────────────────────────────────
// CAPABILITY MODEL
// ─────────────────────────────────────────────────────────────────────────────

export const CAPABILITIES = [
  'fs.read', 'fs.write', 'fs.list',
  'proc.exec', 'proc.spawn', 'mcp.invoke',
] as const;

export type Capability = typeof CAPABILITIES[number];
export const CapabilitySchema = z.enum(CAPABILITIES);

// ─────────────────────────────────────────────────────────────────────────────
// ZOD SCHEMAS
// ─────────────────────────────────────────────────────────────────────────────

export const McpServerConfigSchema = z.object({
  id:           z.string().min(1),
  command:      z.string().min(1),
  args:         z.array(z.string()),
  cwd:          z.string().min(1),
  env:          z.record(z.string(), z.string()),
  capabilities: z.array(CapabilitySchema),
  enabled:      z.boolean(),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const ArgsSchemaTypeSchema = z.enum(['none', 'any_strings', 'single_path', 'multi_path']);
export type ArgsSchemaType = z.infer<typeof ArgsSchemaTypeSchema>;

export const RegisteredCommandRecordSchema = z.object({
  id:                 z.string().min(1),
  command:            z.string().min(1),
  fixedArgs:          z.array(z.string()),
  argsSchemaType:     ArgsSchemaTypeSchema,
  timeoutMs:          z.number().int().positive(),
  cwd:                z.string().min(1),
  envAllowlist:       z.array(z.string()),
  requiredCapability: CapabilitySchema,
});
export type RegisteredCommandRecord = z.infer<typeof RegisteredCommandRecordSchema>;

export interface RegisteredCommand extends RegisteredCommandRecord {
  readonly allowedArgsSchema: z.ZodType<string[]>;
}

export const ExecutionReceiptSchema = z.object({
  id:             z.string().uuid(),
  timestamp:      z.number().int().positive(),
  capability:     CapabilitySchema,
  commandId:      z.string().min(1),
  normalizedArgs: z.array(z.string()),
  exitCode:       z.number().int(),
  durationMs:     z.number().int().min(0),
  stdoutHash:     z.string().length(64),
  stderrHash:     z.string().length(64),
});
export type ExecutionReceipt = z.infer<typeof ExecutionReceiptSchema>;

export interface ExecutionResult extends ExecutionReceipt {
  truncated: boolean;
  timedOut:  boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH CANONICALIZATION
// ─────────────────────────────────────────────────────────────────────────────

// Resolves symlinks via realpathSync. For non-existent paths, walks up to the
// nearest existing ancestor and reconstructs the canonical prefix + suffix.
export function canonicalizePath(inputPath: string): string {
  const abs = nodePath.resolve(inputPath);
  try { return realpathSync(abs); } catch { /* path may not exist yet */ }

  let cur = abs;
  const suffix: string[] = [];
  for (;;) {
    const parent = nodePath.dirname(cur);
    if (parent === cur) break;          // reached filesystem root
    suffix.unshift(nodePath.basename(cur));
    cur = parent;
    try {
      const real = realpathSync(cur);
      return suffix.length ? nodePath.join(real, ...suffix) : real;
    } catch { /* continue */ }
  }
  return abs;                           // fallback: resolve() result
}

// Throws SandboxError if canonicalPath is not under any of the allowlisted roots.
export function assertInSandbox(canonicalPath: string, roots: string[]): void {
  const sep = nodePath.sep;
  const inside = roots.some(root => {
    const r = nodePath.normalize(root);
    return canonicalPath === r || canonicalPath.startsWith(r + sep);
  });
  if (!inside) {
    throw new SandboxError(
      `'${canonicalPath}' is outside sandbox roots [${roots.join(', ')}]`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CAPABILITY VALIDATOR
// ─────────────────────────────────────────────────────────────────────────────

export function hasCapability(agentId: string, capability: Capability): boolean {
  const row = getDb().prepare<[string, string], { id: string }>(
    `SELECT id FROM capability_grants WHERE agent_id = ? AND capability = ?`,
  ).get(agentId, capability);
  return row !== undefined;
}

export function assertCapability(agentId: string, capability: Capability): void {
  if (!hasCapability(agentId, capability)) {
    throw new CapabilityError(
      `agent '${agentId}' is not granted capability '${capability}'`,
    );
  }
}

export function grantCapability(agentId: string, capability: Capability, grantedBy: string): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO capability_grants (id, agent_id, capability, granted_at, granted_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), agentId, capability, Date.now(), grantedBy);
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND REGISTRY (immutable after first load)
// ─────────────────────────────────────────────────────────────────────────────

function resolveArgsSchema(type: ArgsSchemaType): z.ZodType<string[]> {
  switch (type) {
    case 'none':        return z.array(z.string()).max(0);
    case 'any_strings': return z.array(z.string().max(8192));
    case 'single_path': return z.array(z.string().max(4096)).min(1).max(1);
    case 'multi_path':  return z.array(z.string().max(4096)).max(16);
  }
}

let _registry: Map<string, RegisteredCommand> | null = null;

function getRegistry(): Map<string, RegisteredCommand> {
  if (_registry) return _registry;

  interface RawRow {
    id: string; command: string; fixed_args_json: string;
    args_schema_type: string; timeout_ms: number; cwd: string;
    env_allowlist_json: string; required_capability: string;
  }
  const rows = getDb().prepare<[], RawRow>(`SELECT * FROM command_registry`).all();

  const map = new Map<string, RegisteredCommand>();
  for (const row of rows) {
    const record = RegisteredCommandRecordSchema.parse({
      id:                 row.id,
      command:            row.command,
      fixedArgs:          JSON.parse(row.fixed_args_json) as string[],
      argsSchemaType:     row.args_schema_type,
      timeoutMs:          row.timeout_ms,
      cwd:                row.cwd,
      envAllowlist:       JSON.parse(row.env_allowlist_json) as string[],
      requiredCapability: row.required_capability,
    });
    map.set(row.id, { ...record, allowedArgsSchema: resolveArgsSchema(record.argsSchemaType) });
  }
  _registry = map;
  return map;
}

export function getCommand(commandId: string): RegisteredCommand | undefined {
  return getRegistry().get(commandId);
}

// Force a fresh load from DB — for test setup only; never call in production.
export function resetRegistry(): void {
  _registry = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROCESS EXECUTOR
// ─────────────────────────────────────────────────────────────────────────────

export interface ExecuteOptions {
  commandId:     string;
  args:          string[];
  agentId:       string;
  sandboxRoots?: string[];
}

export function executeCommand(opts: ExecuteOptions): Promise<ExecutionResult> {
  const cmd = getRegistry().get(opts.commandId);
  if (!cmd) {
    return Promise.reject(
      new MotorError('UNKNOWN_COMMAND', `'${opts.commandId}' is not registered`),
    );
  }

  // Capability check
  try { assertCapability(opts.agentId, cmd.requiredCapability); }
  catch (e) { return Promise.reject(e); }

  // Args schema validation
  const argsResult = cmd.allowedArgsSchema.safeParse(opts.args);
  if (!argsResult.success) {
    return Promise.reject(new MotorError('INVALID_ARGS', String(argsResult.error)));
  }

  // Sandbox enforcement for fs capabilities
  if (cmd.requiredCapability.startsWith('fs.')) {
    const roots = opts.sandboxRoots ?? [];
    if (roots.length === 0) {
      return Promise.reject(new MotorError('NO_SANDBOX', 'fs capabilities require sandboxRoots'));
    }
    try {
      for (const arg of opts.args) {
        assertInSandbox(canonicalizePath(arg), roots);
      }
    } catch (e) { return Promise.reject(e); }
  }

  // Env: take ONLY keys in envAllowlist from current process env
  const env: Record<string, string> = {};
  for (const key of cmd.envAllowlist) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }

  const finalArgs = [...cmd.fixedArgs, ...opts.args];
  const startTime = Date.now();

  return new Promise<ExecutionResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd.command, finalArgs, {
        shell:    false,
        cwd:      cmd.cwd,
        env:      env as NodeJS.ProcessEnv,
        stdio:    ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
    } catch (err: unknown) {
      reject(new MotorError('SPAWN_FAILED', err instanceof Error ? err.message : String(err)));
      return;
    }

    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = Buffer.alloc(0);
    let truncated = false;
    let timedOut  = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, SIGTERM_GRACE_MS);
    }, cmd.timeoutMs);

    child.stdout!.on('data', (chunk: Buffer) => {
      const room = MAX_STDOUT_BYTES - stdoutBuf.length;
      if (room <= 0) { truncated = true; return; }
      if (chunk.length <= room) {
        stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
      } else {
        stdoutBuf = Buffer.concat([stdoutBuf, chunk.subarray(0, room)]);
        truncated = true;
        child.kill('SIGTERM');
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      const room = MAX_STDERR_BYTES - stderrBuf.length;
      if (room <= 0) return;
      if (chunk.length <= room) {
        stderrBuf = Buffer.concat([stderrBuf, chunk]);
      } else {
        stderrBuf = Buffer.concat([stderrBuf, chunk.subarray(0, room)]);
      }
    });

    child.on('close', (code) => {
      clearTimeout(killTimer);
      const durationMs = Date.now() - startTime;
      const receipt: ExecutionReceipt = {
        id:             randomUUID(),
        timestamp:      startTime,
        capability:     cmd.requiredCapability,
        commandId:      cmd.id,
        normalizedArgs: opts.args,
        exitCode:       code ?? -1,
        durationMs,
        stdoutHash: createHash('sha256').update(stdoutBuf).digest('hex'),
        stderrHash: createHash('sha256').update(stderrBuf).digest('hex'),
      };
      try { writeReceipt(receipt, truncated, timedOut); }
      catch (e) { reject(e); return; }
      resolve({ ...receipt, truncated, timedOut });
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(new MotorError('EXEC_ERROR', err.message));
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP SERVER LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────

interface McpEntry {
  proc:      ChildProcess;
  config:    McpServerConfig;
  startedAt: number;
  status:    'running' | 'stopped' | 'crashed';
}

const _mcpProcesses = new Map<string, McpEntry>();

// Kill all live MCP servers on process exit — prevents orphans.
process.on('exit', () => {
  for (const entry of _mcpProcesses.values()) {
    if (entry.status === 'running') {
      try { entry.proc.kill('SIGKILL'); } catch { /* noop */ }
    }
  }
});

export function startMcpServer(configId: string): void {
  if (_mcpProcesses.get(configId)?.status === 'running') return;

  interface RawServer {
    id: string; command: string; args_json: string; cwd: string;
    env_json: string; capabilities_json: string; enabled: number;
  }
  const row = getDb().prepare<[string], RawServer>(
    `SELECT * FROM mcp_servers WHERE id = ?`,
  ).get(configId);

  if (!row) throw new MotorError('UNKNOWN_SERVER', `MCP server '${configId}' not found`);
  if (!row.enabled) throw new MotorError('SERVER_DISABLED', `MCP server '${configId}' is disabled`);

  const config = McpServerConfigSchema.parse({
    id:           row.id,
    command:      row.command,
    args:         JSON.parse(row.args_json) as string[],
    cwd:          row.cwd,
    env:          JSON.parse(row.env_json) as Record<string, string>,
    capabilities: JSON.parse(row.capabilities_json) as string[],
    enabled:      row.enabled === 1,
  });

  const proc = spawn(config.command, config.args, {
    shell:    false,
    cwd:      config.cwd,
    env:      config.env as NodeJS.ProcessEnv,
    stdio:    'pipe',
    detached: false,
  }) as ChildProcess;

  const entry: McpEntry = { proc, config, startedAt: Date.now(), status: 'running' };
  _mcpProcesses.set(configId, entry);

  proc.on('exit', () => { entry.status = 'crashed'; });
  proc.on('error', () => { entry.status = 'crashed'; });
}

export function stopMcpServer(configId: string, timeoutMs = SIGTERM_GRACE_MS): Promise<void> {
  const entry = _mcpProcesses.get(configId);
  if (!entry || entry.status !== 'running') return Promise.resolve();
  if (entry.proc.exitCode !== null) { entry.status = 'stopped'; return Promise.resolve(); }

  return new Promise<void>((resolve) => {
    const forceKill = setTimeout(() => {
      try { entry.proc.kill('SIGKILL'); } catch { /* noop */ }
    }, timeoutMs);

    entry.proc.once('close', () => {
      clearTimeout(forceKill);
      entry.status = 'stopped';
      resolve();
    });

    try { entry.proc.kill('SIGTERM'); } catch { /* already dead */ }
  });
}

export function getMcpServerStatus(configId: string): 'running' | 'stopped' | 'crashed' | 'unknown' {
  return _mcpProcesses.get(configId)?.status ?? 'unknown';
}

// Heartbeat: returns true if the process is alive (has not exited).
export function pingMcpServer(configId: string): boolean {
  const entry = _mcpProcesses.get(configId);
  if (!entry) return false;
  return entry.status === 'running' && entry.proc.exitCode === null;
}

// ─────────────────────────────────────────────────────────────────────────────
// RECEIPT LOGGER (append-only)
// ─────────────────────────────────────────────────────────────────────────────

function writeReceipt(receipt: ExecutionReceipt, truncated: boolean, timedOut: boolean): void {
  getDb().prepare(`
    INSERT INTO execution_receipts
      (id, timestamp, capability, command_id, normalized_args_json,
       exit_code, duration_ms, stdout_hash, stderr_hash, truncated, timed_out)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    receipt.id,
    receipt.timestamp,
    receipt.capability,
    receipt.commandId,
    JSON.stringify(receipt.normalizedArgs),
    receipt.exitCode,
    receipt.durationMs,
    receipt.stdoutHash,
    receipt.stderrHash,
    truncated ? 1 : 0,
    timedOut  ? 1 : 0,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT VALIDATOR
// ─────────────────────────────────────────────────────────────────────────────

export interface MotorCortexReport {
  valid:  boolean;
  errors: string[];
}

export function validateMotorCortex(): MotorCortexReport {
  const db     = getDb();
  const errors: string[] = [];

  // All capability_grants must reference a known capability
  const grants = db.prepare<[], { capability: string }>(
    `SELECT capability FROM capability_grants`,
  ).all() as Array<{ capability: string }>;
  for (const g of grants) {
    if (!(CAPABILITIES as readonly string[]).includes(g.capability)) {
      errors.push(`unknown capability in grants: '${g.capability}'`);
    }
  }

  // All command_registry entries must have valid schema type and capability
  interface CmdRow { id: string; args_schema_type: string; required_capability: string }
  const cmds = db.prepare<[], CmdRow>(
    `SELECT id, args_schema_type, required_capability FROM command_registry`,
  ).all() as CmdRow[];
  for (const c of cmds) {
    if (!ArgsSchemaTypeSchema.safeParse(c.args_schema_type).success) {
      errors.push(`command '${c.id}' invalid args_schema_type: '${c.args_schema_type}'`);
    }
    if (!CapabilitySchema.safeParse(c.required_capability).success) {
      errors.push(`command '${c.id}' unknown required_capability: '${c.required_capability}'`);
    }
  }

  return { valid: errors.length === 0, errors };
}
