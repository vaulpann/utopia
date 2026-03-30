import { Command } from 'commander';
import chalk from 'chalk';
import { resolve, extname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { loadConfig, configExists } from '../utils/config.js';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.utopia', 'dist', 'build', '__pycache__',
  '.next', '.vercel', 'coverage', '.nyc_output', 'venv', '.venv', 'env',
]);

async function countInstrumentedFiles(dir: string): Promise<{ fileCount: number; probeCount: number }> {
  let fileCount = 0;
  let probeCount = 0;

  async function walk(currentDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      if (IGNORED_DIRS.has(entry.name)) continue;

      const fullPath = resolve(currentDir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        if (['.js', '.jsx', '.ts', '.tsx', '.py'].includes(ext)) {
          try {
            const content = await readFile(fullPath, 'utf-8');
            const jsMatches = content.match(/\/\/ utopia:probe/g);
            const pyMatches = content.match(/# utopia:probe/g);
            const total = (jsMatches?.length ?? 0) + (pyMatches?.length ?? 0);
            if (total > 0) {
              fileCount++;
              probeCount += total;
            }
          } catch {
            // Skip unreadable files
          }
        }
      }
    }
  }

  await walk(dir);
  return { fileCount, probeCount };
}

interface HealthResponse {
  status: string;
  timestamp: string;
}

interface StatsResponse {
  probes: {
    total: number;
    byType: Record<string, number>;
  };
  graph: {
    nodes: number;
    edges: number;
  };
}

async function checkServiceHealth(endpoint: string): Promise<{ healthy: boolean; latencyMs: number }> {
  try {
    const start = Date.now();
    const url = new URL('/api/v1/health', endpoint);
    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Date.now() - start;

    if (response.ok) {
      const data = (await response.json()) as HealthResponse;
      return { healthy: data.status === 'ok', latencyMs };
    }
    return { healthy: false, latencyMs };
  } catch {
    return { healthy: false, latencyMs: 0 };
  }
}

async function fetchStats(endpoint: string): Promise<StatsResponse | null> {
  try {
    const url = new URL('/api/v1/admin/stats', endpoint);
    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      return (await response.json()) as StatsResponse;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if the utopia-runtime is properly installed as a dependency.
 */
function checkRuntimeInstalled(cwd: string): { installed: boolean; method: string } {
  // Check for file: dependency approach (.utopia/runtime/)
  const runtimeDir = resolve(cwd, '.utopia', 'runtime');
  if (existsSync(resolve(runtimeDir, 'index.js')) && existsSync(resolve(runtimeDir, 'package.json'))) {
    // Also verify it's in package.json
    try {
      const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf-8'));
      if (pkg.dependencies?.['utopia-runtime']?.includes('file:')) {
        return { installed: true, method: 'file: dependency (.utopia/runtime)' };
      }
    } catch { /* ignore */ }
    return { installed: true, method: '.utopia/runtime (not yet in package.json)' };
  }

  // Check for legacy direct node_modules approach
  if (existsSync(resolve(cwd, 'node_modules', 'utopia-runtime', 'index.js'))) {
    return { installed: true, method: 'node_modules (legacy)' };
  }

  return { installed: false, method: 'not installed' };
}

/**
 * Check if a background serve process is running.
 */
function checkBackgroundProcess(cwd: string): { running: boolean; pid: number | null } {
  const pidPath = resolve(cwd, '.utopia', 'serve.pid');
  if (!existsSync(pidPath)) return { running: false, pid: null };

  try {
    const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
    if (isNaN(pid)) return { running: false, pid: null };

    // Check if process is alive
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false, pid: null };
  }
}

/**
 * Check if environment variables are configured.
 */
function checkEnvVars(cwd: string, framework: string): { found: boolean; fileName: string; missing: string[] } {
  const envFileName = framework === 'nextjs' ? '.env.local' : '.env';
  const envFilePath = resolve(cwd, envFileName);

  const requiredVars = ['UTOPIA_ENDPOINT', 'UTOPIA_PROJECT_ID'];
  const missing: string[] = [];

  if (!existsSync(envFilePath)) {
    return { found: false, fileName: envFileName, missing: requiredVars };
  }

  try {
    const content = readFileSync(envFilePath, 'utf-8');
    for (const varName of requiredVars) {
      if (!content.includes(varName + '=')) {
        missing.push(varName);
      }
    }
    return { found: true, fileName: envFileName, missing };
  } catch {
    return { found: false, fileName: envFileName, missing: requiredVars };
  }
}

export const statusCommand = new Command('status')
  .description('Check the status of your Utopia setup')
  .action(async () => {
    const cwd = process.cwd();

    console.log(chalk.bold.cyan('\n  Utopia Status\n'));

    // 1. Check config
    const hasConfig = configExists(cwd);
    if (hasConfig) {
      console.log(chalk.green('  [x] Configuration found (.utopia/config.json)'));
    } else {
      console.log(chalk.red('  [ ] Configuration not found'));
      console.log(chalk.dim('      Run "utopia init" to set up your project.\n'));
      return;
    }

    let config;
    try {
      config = await loadConfig(cwd);
      console.log(chalk.dim(`      Project: ${config.projectId}`));
      console.log(chalk.dim(`      Provider: ${config.cloudProvider} / ${config.service}`));
      console.log(chalk.dim(`      Languages: ${config.language.join(', ')}`));
      console.log(chalk.dim(`      Framework: ${config.framework}`));
    } catch (err) {
      console.log(chalk.red(`  [!] Configuration exists but could not be loaded: ${(err as Error).message}`));
      return;
    }

    console.log('');

    // 2. Check environment variables
    const envCheck = checkEnvVars(cwd, config.framework);
    if (envCheck.found && envCheck.missing.length === 0) {
      console.log(chalk.green(`  [x] Environment variables configured (${envCheck.fileName})`));
    } else if (envCheck.found && envCheck.missing.length > 0) {
      console.log(chalk.yellow(`  [~] Environment variables partially configured (${envCheck.fileName})`));
      console.log(chalk.dim(`      Missing: ${envCheck.missing.join(', ')}`));
    } else {
      console.log(chalk.yellow(`  [ ] Environment file not found (${envCheck.fileName})`));
      console.log(chalk.dim('      Run "utopia init" to set up environment variables.'));
    }

    console.log('');

    // 3. Check runtime installation
    const runtime = checkRuntimeInstalled(cwd);
    if (runtime.installed) {
      console.log(chalk.green(`  [x] Runtime installed (${runtime.method})`));
    } else {
      console.log(chalk.yellow('  [ ] Runtime not installed'));
      console.log(chalk.dim('      Run "utopia instrument" to install the runtime and add probes.'));
    }

    console.log('');

    // 4. Check instrumented files
    console.log(chalk.dim('  Scanning for instrumented files...'));
    const { fileCount, probeCount } = await countInstrumentedFiles(cwd);

    if (fileCount > 0) {
      console.log(chalk.green(`  [x] Instrumented: ${fileCount} file(s), ${probeCount} probe(s)`));
    } else {
      console.log(chalk.yellow('  [ ] No instrumented files found'));
      console.log(chalk.dim('      Run "utopia instrument" to add probes to your codebase.'));
    }

    console.log('');

    // 5. Check data service
    const endpoint = config.dataEndpoint;
    console.log(chalk.dim(`  Checking data service at ${endpoint}...`));

    // Also check for background process
    const bgProcess = checkBackgroundProcess(cwd);

    const health = await checkServiceHealth(endpoint);

    if (health.healthy) {
      const bgInfo = bgProcess.running ? ` (background, PID ${bgProcess.pid})` : '';
      console.log(chalk.green(`  [x] Data service is running${bgInfo} (${health.latencyMs}ms latency)`));

      // Fetch stats if service is healthy
      const stats = await fetchStats(endpoint);

      if (stats) {
        console.log(chalk.dim(`      Stored probes: ${stats.probes.total}`));

        if (Object.keys(stats.probes.byType).length > 0) {
          for (const [type, count] of Object.entries(stats.probes.byType)) {
            console.log(chalk.dim(`        ${type}: ${count}`));
          }
        }

        console.log(chalk.dim(`      Graph: ${stats.graph.nodes} nodes, ${stats.graph.edges} edges`));
      } else {
        console.log(chalk.yellow('  [~] Could not fetch stats'));
      }
    } else {
      if (bgProcess.running) {
        console.log(chalk.yellow(`  [~] Background process found (PID ${bgProcess.pid}) but health check failed`));
      } else {
        console.log(chalk.yellow('  [ ] Data service is not reachable'));
      }

      if (endpoint.includes('localhost') || endpoint.includes('127.0.0.1')) {
        console.log(chalk.dim('      Run "utopia serve" to start the local data service.'));
      } else {
        console.log(chalk.dim(`      Check that your service is running at ${endpoint}`));
      }
    }

    // Summary
    console.log('');
    const allGood = hasConfig
      && envCheck.missing.length === 0
      && runtime.installed
      && fileCount > 0
      && health.healthy;

    if (allGood) {
      console.log(chalk.bold.green('  Everything looks good! Utopia is fully operational.\n'));
    } else {
      console.log(chalk.bold.yellow('  Some components need attention. See details above.\n'));
    }
  });
