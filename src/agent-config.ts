import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { config } from './config';

// ---------- Typed Agent I/O Protocol (AGENT-1) ----------
export const AgentRequestSchema = z.object({
  id:            z.string().min(1),
  type:          z.enum(['task', 'checkpoint', 'shutdown']),
  payload:       z.string(),
  contextBudget: z.number().int().nonnegative(),
  timestamp:     z.number().int(),
});
export type AgentRequest = z.infer<typeof AgentRequestSchema>;

export const AgentResponseSchema = z.object({
  id:         z.string().min(1),
  type:       z.enum(['result', 'checkpoint', 'error', 'done']),
  payload:    z.string(),
  tokenCount: z.number().int().nonnegative().optional(),
  timestamp:  z.number().int(),
});
export type AgentResponse = z.infer<typeof AgentResponseSchema>;

export interface AgentDefinition {
  id: string;
  name: string;
  title: string;
  role: string;
  description: string;
  model: string;
  tools: string[];
  mcpServers: string[];
  maxTurns: number;
  systemPrompt: string;
  dir: string;
}

export const AGENT_IDS = ['main', 'comms', 'content', 'ops', 'research'] as const;
export type AgentId = typeof AGENT_IDS[number];

let registry: Record<string, AgentDefinition> | null = null;

function agentsRoot(): string {
  return path.join(config.projectRoot, 'agents');
}

function loadOne(id: string): AgentDefinition {
  const dir = path.join(agentsRoot(), id);
  const yamlPath = path.join(dir, 'agent.yaml');
  const promptPath = path.join(dir, 'CLAUDE.md');
  if (!fs.existsSync(yamlPath)) throw new Error(`agent.yaml missing for ${id} at ${yamlPath}`);
  if (!fs.existsSync(promptPath)) throw new Error(`CLAUDE.md missing for ${id} at ${promptPath}`);
  const parsed = yaml.load(fs.readFileSync(yamlPath, 'utf-8')) as any;
  const systemPrompt = fs.readFileSync(promptPath, 'utf-8');
  return {
    id,
    name: parsed.name ?? id,
    title: parsed.title ?? id,
    role: parsed.role ?? 'specialist',
    description: parsed.description ?? '',
    model: parsed.model ?? (id === 'main' ? config.mainModel : config.agentModel),
    tools: Array.isArray(parsed.tools) ? parsed.tools : [],
    mcpServers: Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [],
    maxTurns: Number(parsed.maxTurns) || config.agentMaxTurns,
    systemPrompt,
    dir,
  };
}

export function loadRegistry(force = false): Record<string, AgentDefinition> {
  if (registry && !force) return registry;
  const next: Record<string, AgentDefinition> = {};
  for (const id of AGENT_IDS) next[id] = loadOne(id);
  registry = next;
  return registry;
}

export function getAgent(id: string): AgentDefinition {
  const reg = loadRegistry();
  const def = reg[id];
  if (!def) throw new Error(`unknown agent: ${id}`);
  return def;
}

export function listAgents(): AgentDefinition[] {
  return Object.values(loadRegistry());
}

export function listSpecialists(): AgentDefinition[] {
  return listAgents().filter(a => a.id !== 'main');
}

export function isValidAgentId(id: string): id is AgentId {
  return (AGENT_IDS as readonly string[]).includes(id);
}
