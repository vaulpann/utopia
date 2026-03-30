import { Command } from 'commander';
import chalk from 'chalk';
import { resolve, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import { loadConfig, configExists } from '../utils/config.js';

const PID_FILE = '.utopia/serve.pid';
const LOG_FILE = '.utopia/serve.log';

function isPortInUse(port: number): boolean {
  try {
    execSync(`lsof -ti:${port}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function killPort(port: number): void {
  try {
    execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: 'pipe' });
  } catch { /* nothing on that port */ }
}

function readRunningPid(cwd: string): number | null {
  const pidPath = resolve(cwd, PID_FILE);
  if (!existsSync(pidPath)) return null;
  try {
    const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
    if (isNaN(pid)) return null;
    process.kill(pid, 0); // throws if not running
    return pid;
  } catch {
    try { unlinkSync(pidPath); } catch { /* ignore */ }
    return null;
  }
}

export const serveCommand = new Command('serve')
  .description('Start the Utopia data service')
  .option('--port <port>', 'Port number for the data service')
  .option('--db <path>', 'Path to the SQLite database file')
  .option('-b, --background', 'Run the server as a background process')
  .option('--stop', 'Stop a running background server')
  .action(async (options) => {
    const cwd = process.cwd();
    const isBackgroundChild = process.env.__UTOPIA_BG_CHILD === '1';

    // Handle --stop
    if (options.stop) {
      const pid = readRunningPid(cwd);
      if (pid) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
        try { unlinkSync(resolve(cwd, PID_FILE)); } catch { /* ignore */ }
        console.log(chalk.green(`\n  Utopia data service stopped (PID ${pid}).\n`));
      } else {
        console.log(chalk.yellow('\n  No running Utopia data service found.\n'));
      }
      return;
    }

    // Read config for port default
    let defaultPort = 7890;
    const defaultDb = resolve(cwd, '.utopia', 'data.db');
    if (configExists(cwd)) {
      try {
        const config = await loadConfig(cwd);
        if (config.dataEndpoint) {
          try { const url = new URL(config.dataEndpoint); if (url.port) defaultPort = parseInt(url.port, 10); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }

    const port = options.port ? parseInt(options.port as string, 10) : defaultPort;
    const dbPath = (options.db as string) || defaultDb;

    if (isNaN(port) || port < 1 || port > 65535) {
      console.log(chalk.red('\n  Error: Invalid port number.\n'));
      process.exit(1);
    }

    // Background mode
    if (options.background) {
      console.log(chalk.bold.cyan('\n  Starting Utopia Data Service (background)...\n'));

      // Check if port is already in use
      if (isPortInUse(port)) {
        // Check if it's our own process
        const existingPid = readRunningPid(cwd);
        if (existingPid) {
          console.log(chalk.yellow(`  Already running (PID ${existingPid}) on port ${port}.`));
          console.log(chalk.dim('  Run "utopia serve --stop" first.\n'));
        } else {
          console.log(chalk.red(`  Error: Port ${port} is already in use by another process.`));
          console.log(chalk.dim(`  Run: lsof -ti:${port} | xargs kill    to free it.\n`));
        }
        return;
      }

      const __filename = fileURLToPath(import.meta.url);
      const binPath = resolve(dirname(__filename), '..', '..', '..', 'bin', 'utopia.js');
      const logPath = resolve(cwd, LOG_FILE);
      const pidPath = resolve(cwd, PID_FILE);
      const logFd = openSync(logPath, 'w');

      const child = spawn(
        process.execPath,
        [binPath, 'serve', '--port', String(port), '--db', dbPath],
        {
          cwd,
          detached: true,
          stdio: ['ignore', logFd, logFd],
          env: { ...process.env, __UTOPIA_BG_CHILD: '1' },
        }
      );

      if (!child.pid) {
        console.log(chalk.red('  Error: Failed to spawn background process.\n'));
        process.exit(1);
      }

      writeFileSync(pidPath, String(child.pid));
      child.unref();

      // Wait and verify it actually started
      let healthy = false;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const resp = await fetch(`http://localhost:${port}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
          if (resp.ok) { healthy = true; break; }
        } catch { /* not ready yet */ }
      }

      if (healthy) {
        console.log(chalk.dim(`  Port:     ${port}`));
        console.log(chalk.dim(`  Database: ${dbPath}`));
        console.log(chalk.dim(`  PID:      ${child.pid}`));
        console.log(chalk.dim(`  Log:      ${logPath}`));
        console.log('');
        console.log(chalk.bold.green('  Utopia data service is running.'));
        console.log(chalk.dim('  Run "utopia serve --stop" to stop it.\n'));
      } else {
        // Child likely crashed — read the log
        let logContent = '';
        try { logContent = readFileSync(logPath, 'utf-8').trim(); } catch { /* ignore */ }
        try { unlinkSync(pidPath); } catch { /* ignore */ }

        console.log(chalk.red('  Error: Server failed to start.\n'));
        if (logContent) {
          // Pull out the useful error
          const addrInUse = logContent.includes('EADDRINUSE');
          if (addrInUse) {
            console.log(chalk.red(`  Port ${port} is already in use.`));
            console.log(chalk.dim(`  Run: lsof -ti:${port} | xargs kill    to free it.\n`));
          } else {
            console.log(chalk.dim('  Log output:'));
            console.log(chalk.dim('  ' + logContent.split('\n').slice(0, 5).join('\n  ')));
            console.log('');
          }
        }
        process.exit(1);
      }
      return;
    }

    // Foreground mode
    if (!isBackgroundChild) {
      console.log(chalk.bold.cyan('\n  Starting Utopia Data Service...\n'));
      console.log(chalk.dim(`  Port:     ${port}`));
      console.log(chalk.dim(`  Database: ${dbPath}`));
    }

    try {
      const { startServer } = await import('../../server/index.js');
      startServer(port, dbPath);

      if (!isBackgroundChild) {
        console.log('');
        console.log(chalk.bold.green('  Utopia data service is running!'));
        console.log('');
        console.log(`  Endpoint:  ${chalk.cyan(`http://localhost:${port}`)}`);
        console.log(`  Health:    ${chalk.cyan(`http://localhost:${port}/api/v1/health`)}`);
        console.log(`  Probes:    ${chalk.cyan(`http://localhost:${port}/api/v1/probes`)}`);
        console.log('');
        console.log(chalk.dim('  Press Ctrl+C to stop the server.\n'));
      }
    } catch (err) {
      console.error(`[utopia-server] Failed to start: ${(err as Error).message}`);
      process.exit(1);
    }
  });
