import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const CONFIG_DIR = '.utopia';
const CONFIG_FILE = 'config.json';

export type SupportedFramework = 'nextjs' | 'react' | 'python' | 'unsupported';
export type DataMode = 'schemas' | 'full';
export type ProbeGoal = 'debugging' | 'security' | 'both';
export type AgentType = 'claude' | 'codex';
export type UtopiaMode = 'instrument' | 'heal' | 'both';

export interface UtopiaConfig {
  version: string;
  projectId: string;
  cloudProvider: string;
  service: string;
  deploymentMethod: string;
  isStandalone: boolean;
  dataEndpoint: string;
  language: string[];
  framework: SupportedFramework;
  dataMode: DataMode;
  probeGoal: ProbeGoal;
  agent: AgentType;
  utopiaMode: UtopiaMode;
}

export async function loadConfig(dir?: string): Promise<UtopiaConfig> {
  const base = dir || process.cwd();
  const configPath = resolve(base, CONFIG_DIR, CONFIG_FILE);
  const raw = await readFile(configPath, 'utf-8');
  return JSON.parse(raw);
}

export async function saveConfig(config: UtopiaConfig, dir?: string): Promise<void> {
  const base = dir || process.cwd();
  const configDir = resolve(base, CONFIG_DIR);
  if (!existsSync(configDir)) await mkdir(configDir, { recursive: true });
  await writeFile(resolve(configDir, CONFIG_FILE), JSON.stringify(config, null, 2));

  const gitignorePath = resolve(configDir, '.gitignore');
  await writeFile(gitignorePath, 'config.json\ndata.db\nserve.pid\nserve.log\nsnapshots/\nfixes/\nFIXES.md\n');
}

export function configExists(dir?: string): boolean {
  const base = dir || process.cwd();
  return existsSync(resolve(base, CONFIG_DIR, CONFIG_FILE));
}

export function detectPackageManager(dir: string): 'pnpm' | 'yarn' | 'npm' {
  if (existsSync(resolve(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(resolve(dir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}
