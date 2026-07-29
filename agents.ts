/**
 * Agent discovery and configuration
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentDir, parseFrontmatter } from '@earendil-works/pi-coding-agent';

export type AgentScope = 'user' | 'project' | 'both';

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[] | undefined;
  model?: string | undefined;
  systemPrompt: string;
  source: 'packaged' | 'user' | 'project';
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
  packagedAgentsDir: string | null;
}

async function loadAgentsFromDir(
  dir: string,
  source: 'packaged' | 'user' | 'project',
): Promise<AgentConfig[]> {
  const agents: AgentConfig[] = [];

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = await fs.promises.readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    const { frontmatter, body } =
      parseFrontmatter<Record<string, string>>(content);

    if (!frontmatter['name'] || !frontmatter['description']) {
      continue;
    }

    const tools = frontmatter['tools']
      ?.split(',')
      .map((t: string) => t.trim())
      .filter(Boolean);

    agents.push({
      name: frontmatter['name'],
      description: frontmatter['description'],
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter['model'],
      systemPrompt: body,
      source,
      filePath,
    });
  }

  return agents;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function findNearestProjectAgentsDir(
  cwd: string,
): Promise<string | null> {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, '.pi', 'agents');
    if (await isDirectory(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

async function getPackagedAgentsDir(): Promise<string | null> {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);

  // Support both common package layouts:
  // - source/manual install: <package>/index.ts, <package>/agents.ts, <package>/agents/
  // - compiled layout:       <package>/dist/agents.js or <package>/src/agents.ts, <package>/agents/
  const candidates = [
    path.join(currentDir, 'agents'),
    path.join(currentDir, '..', 'agents'),
  ];

  for (const candidate of candidates) {
    if (await isDirectory(candidate)) return candidate;
  }

  return null;
}

export async function discoverAgents(
  cwd: string,
  scope: AgentScope,
): Promise<AgentDiscoveryResult> {
  const userDir = path.join(getAgentDir(), 'agents');
  const projectAgentsDir = await findNearestProjectAgentsDir(cwd);
  const packagedAgentsDir = await getPackagedAgentsDir();

  const packagedAgents = packagedAgentsDir
    ? await loadAgentsFromDir(packagedAgentsDir, 'packaged')
    : [];
  const userAgents =
    scope === 'project' ? [] : await loadAgentsFromDir(userDir, 'user');
  const projectAgents =
    scope === 'user' || !projectAgentsDir
      ? []
      : await loadAgentsFromDir(projectAgentsDir, 'project');

  const agentMap = new Map<string, AgentConfig>();

  for (const agent of packagedAgents) agentMap.set(agent.name, agent);
  if (scope === 'both') {
    for (const agent of userAgents) agentMap.set(agent.name, agent);
    for (const agent of projectAgents) agentMap.set(agent.name, agent);
  } else if (scope === 'user') {
    for (const agent of userAgents) agentMap.set(agent.name, agent);
  } else {
    for (const agent of projectAgents) agentMap.set(agent.name, agent);
  }

  return {
    agents: Array.from(agentMap.values()),
    projectAgentsDir,
    packagedAgentsDir,
  };
}

export function formatAgentList(
  agents: AgentConfig[],
  maxItems: number,
): { text: string; remaining: number } {
  if (agents.length === 0) return { text: 'none', remaining: 0 };
  const listed = agents.slice(0, maxItems);
  const remaining = agents.length - listed.length;
  return {
    text: listed
      .map((a) => `${a.name} (${a.source}): ${a.description}`)
      .join('; '),
    remaining,
  };
}
