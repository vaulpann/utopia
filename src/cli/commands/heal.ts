import { Command } from 'commander';
import chalk from 'chalk';
import { resolve, dirname } from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, rmSync } from 'node:fs';

import { loadConfig, configExists } from '../utils/config.js';
import type { UtopiaConfig } from '../utils/config.js';

// ---------------------------------------------------------------------------
// Runtime installation (same package as probes — utopia-runtime)
// ---------------------------------------------------------------------------

function installPythonRuntime(cwd: string): { ok: boolean; error?: string } {
  const venvDirs = ['.venv', 'venv', 'env', '.env'];
  let pip = '';
  for (const vdir of venvDirs) {
    const pipPath = resolve(cwd, vdir, 'bin', 'pip');
    if (existsSync(pipPath)) { pip = pipPath; break; }
  }
  if (!pip && process.env.VIRTUAL_ENV) {
    const venvPip = resolve(process.env.VIRTUAL_ENV, 'bin', 'pip');
    if (existsSync(venvPip)) pip = venvPip;
  }
  if (!pip) pip = 'pip3';

  try {
    execSync(`${pip} install utopia-runtime --quiet 2>&1`, { cwd, stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `pip install utopia-runtime failed: ${(err as Error).message}` };
  }
}

function checkOpenAIKey(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

// ---------------------------------------------------------------------------
// Prompt for the agent
// ---------------------------------------------------------------------------

function buildHealPrompt(config: UtopiaConfig): string {
  return `You are adding self-healing capabilities to a Python codebase using the Utopia SDK.

The Utopia SDK provides a \`@utopia\` decorator that wraps Python functions with automatic error recovery. When a decorated function throws an exception at runtime:

1. The error and function source code are sent to the OpenAI API
2. OpenAI generates a fix
3. The fix is hot-patched and re-executed at runtime
4. The fix is logged to \`.utopia/fixes/\` and \`.utopia/FIXES.md\` so that next time a coding agent (you!) spins up, the fix is already there — ready to be permanently applied

## How to import

\`\`\`python
from utopia_runtime import utopia
\`\`\`

## How to use the decorator

\`\`\`python
from utopia_runtime import utopia

@utopia
def process_payment(order_id: str, amount: float):
    # If this crashes at runtime, it self-heals
    ...

@utopia
async def fetch_user_data(user_id: str):
    # Works with async functions too
    ...

@utopia(ignore=[ValueError, KeyError])
def strict_parser(data: str):
    # ValueError and KeyError are INTENTIONAL here — they pass through untouched
    # Other unexpected errors will still self-heal
    if not data:
        raise ValueError("data is required")
    return json.loads(data)
\`\`\`

## Intentional vs unexpected errors

The \`ignore\` parameter tells \`@utopia\` which exception types are **intentional** — these are errors the function raises on purpose as part of its contract (validation errors, not-found errors, permission errors, etc.). They pass through with zero overhead.

**Everything else** is treated as an unexpected bug and triggers self-healing.

Use \`ignore\` when a function intentionally raises:
- \`ValueError\` / \`TypeError\` for input validation
- \`KeyError\` / \`IndexError\` for lookup failures that callers handle
- \`PermissionError\` / \`AuthenticationError\` for access control
- Custom exception classes that are part of the function's API

## Configuration (already handled — users set these env vars)

\`\`\`
OPENAI_API_KEY=sk-...     # Required — the API key for self-healing
UTOPIA_MODEL=gpt-4o       # Optional — defaults to gpt-4o
\`\`\`

Or in code:
\`\`\`python
from utopia_runtime import configure
configure(api_key="sk-...", model="gpt-4o-mini")
\`\`\`

## Your Task

1. **Explore the codebase.** Understand the architecture, find all Python files, identify the important functions.

2. **Add the \`@utopia\` decorator to functions that should self-heal.** These are functions where runtime errors would be most impactful:

   **MUST decorate:**
   - API route handlers / view functions / endpoint handlers
   - Functions that process external data (API responses, user input, file parsing)
   - Functions that interact with databases (queries, mutations, migrations)
   - Functions that call external services or APIs
   - Business logic functions (payment processing, data transformations, calculations)
   - Functions that handle authentication / authorization
   - Data processing / ETL functions
   - CLI command handlers
   - Background task / job handlers
   - Webhook handlers

   **DO NOT decorate:**
   - Tiny utility functions (string formatting, simple getters)
   - Functions that are just type definitions or constants
   - Test functions
   - Functions that are already wrapped in comprehensive error handling with custom recovery logic
   - \`__init__\`, \`__repr__\`, \`__str__\` and similar dunder methods
   - Functions in third-party or generated code

3. **Add the import to every file where you add decorators:**
   \`\`\`python
   from utopia_runtime import utopia
   \`\`\`
   - Add it near the top with other imports
   - Check if it's already imported first — don't duplicate

4. **Placement rules:**
   - The \`@utopia\` decorator should be the OUTERMOST decorator (first one, closest to the function name)
   - If there are other decorators, \`@utopia\` goes BELOW them (it wraps the already-decorated function)
   - Example:
     \`\`\`python
     @app.route("/users")    # framework decorator on top
     @require_auth           # middleware decorator
     @utopia                 # utopia goes last (outermost wrapper)
     def get_users():
         ...
     \`\`\`

5. **Be thorough but smart.** The goal is to protect the functions where errors actually matter — the ones that would break the user experience, corrupt data, or cause outages. Every function you decorate becomes self-healing.

6. **Give a summary** of what you decorated and why. Group by file.

Remember: Every \`@utopia\` decorator you add is a function that will fix itself at runtime instead of crashing. The fix gets logged so you can apply it permanently next time. This is the future.`;
}

// ---------------------------------------------------------------------------
// File snapshotting (same pattern as instrument.ts)
// ---------------------------------------------------------------------------

const SNAPSHOT_DIR = '.utopia/snapshots';
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.utopia', '.git', '__pycache__', 'venv', '.venv', 'coverage', '.env', 'env']);
const SOURCE_EXTS = new Set(['.py']);

function snapshotFiles(cwd: string): number {
  const snapshotBase = resolve(cwd, SNAPSHOT_DIR);
  let count = 0;

  function walk(dir: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;
      const full = resolve(dir, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else if (st.isFile()) {
          const ext = full.substring(full.lastIndexOf('.'));
          if (!SOURCE_EXTS.has(ext)) continue;
          const rel = full.substring(cwd.length + 1);
          const snapPath = resolve(snapshotBase, rel);
          if (!existsSync(snapPath)) {
            mkdirSync(dirname(snapPath), { recursive: true });
            writeFileSync(snapPath, readFileSync(full));
            count++;
          }
        }
      } catch { /* skip unreadable */ }
    }
  }

  walk(cwd);
  return count;
}

function pruneUnchangedSnapshots(cwd: string): void {
  const snapshotBase = resolve(cwd, SNAPSHOT_DIR);
  if (!existsSync(snapshotBase)) return;

  function walk(dir: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = resolve(dir, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
          try {
            const remaining = readdirSync(full);
            if (remaining.length === 0) rmSync(full, { recursive: true });
          } catch { /* ignore */ }
        } else if (st.isFile()) {
          const rel = full.substring(snapshotBase.length + 1);
          const sourcePath = resolve(cwd, rel);
          if (!existsSync(sourcePath)) {
            unlinkSync(full);
            continue;
          }
          const snapshot = readFileSync(full);
          const current = readFileSync(sourcePath);
          if (snapshot.equals(current)) {
            unlinkSync(full);
          }
        }
      } catch { /* skip */ }
    }
  }

  walk(snapshotBase);
}

// ---------------------------------------------------------------------------
// Agent session (same pattern as instrument.ts)
// ---------------------------------------------------------------------------

function checkAgentAvailable(agent: string): boolean {
  const cmd = agent === 'codex' ? 'codex' : 'claude';
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function spawnAgentSession(cwd: string, prompt: string, agent: string): Promise<number> {
  return new Promise<number>((resolvePromise) => {
    let child: ReturnType<typeof spawn>;

    const tmpPromptFile = resolve(cwd, '.utopia', '.prompt.tmp');
    mkdirSync(dirname(tmpPromptFile), { recursive: true });
    writeFileSync(tmpPromptFile, prompt);

    if (agent === 'codex') {
      child = spawn('codex', [
        'exec', readFileSync(tmpPromptFile, 'utf-8'),
        '--full-auto',
        '--skip-git-repo-check',
      ], {
        cwd,
        stdio: ['ignore', 'inherit', 'pipe'],
        env: { ...process.env },
      });

      const frames = ['\u28CB', '\u28D9', '\u28F9', '\u28F8', '\u28FC', '\u28F4', '\u28E6', '\u28E7', '\u28C7', '\u28CF'];
      let frame = 0;
      const startTime = Date.now();
      const spinner = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const min = Math.floor(elapsed / 60);
        const sec = elapsed % 60;
        const timeStr = min > 0 ? `${min}m ${sec}s` : `${sec}s`;
        process.stdout.write(`\r  ${frames[frame % frames.length]} Codex is adding self-healing decorators... (${timeStr})  `);
        frame++;
      }, 100);
      child.on('close', () => { clearInterval(spinner); process.stdout.write('\r' + ' '.repeat(70) + '\r'); });
    } else {
      child = spawn('claude', [
        '-p', prompt,
        '--allowedTools', 'Edit,Read,Grep,Glob,Bash,Write',
        '--permission-mode', 'acceptEdits',
        '--output-format', 'stream-json',
        '--verbose',
      ], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    }

    // Clean up temp file
    try { unlinkSync(tmpPromptFile); } catch { /* ignore */ }

    let errorOutput = '';
    let filesEdited = 0;
    let filesRead = 0;

    child.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);

          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text) {
                process.stdout.write(chalk.dim(block.text));
              }
              if (block.type === 'tool_use') {
                if (block.name === 'Edit' || block.name === 'Write') {
                  filesEdited++;
                  const fp = (block.input?.file_path || '').split('/').slice(-2).join('/');
                  console.log(chalk.green(`  [${filesEdited}] Decorated: ${fp}`));
                } else if (block.name === 'Read') {
                  filesRead++;
                  const fp = (block.input?.file_path || '').split('/').slice(-2).join('/');
                  if (filesRead <= 20 || filesRead % 10 === 0) {
                    console.log(chalk.dim(`  Reading: ${fp}`));
                  }
                } else if (block.name === 'Grep' || block.name === 'Glob') {
                  console.log(chalk.dim(`  Searching: ${block.input?.pattern || '...'}`));
                }
              }
            }
          }
          if (msg.type === 'result' && msg.result) {
            console.log('\n' + chalk.white(msg.result));
          }

          if (msg.type === 'message' && msg.content) {
            process.stdout.write(chalk.dim(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)));
          }
          if (msg.type === 'tool_call' || msg.type === 'function_call') {
            const name = msg.name || msg.function?.name || '';
            if (name.includes('edit') || name.includes('write') || name.includes('patch')) {
              filesEdited++;
              console.log(chalk.green(`  [${filesEdited}] Decorated: ${msg.arguments?.path || msg.arguments?.file || '...'}`));
            } else if (name.includes('read')) {
              filesRead++;
              if (filesRead <= 20 || filesRead % 10 === 0) {
                console.log(chalk.dim(`  Reading: ${msg.arguments?.path || msg.arguments?.file || '...'}`));
              }
            }
          }
        } catch { /* partial JSON line */ }
      }
    });

    child.stderr?.on('data', (data: Buffer) => { errorOutput += data.toString(); });

    child.on('close', (code) => {
      if (code !== 0 && errorOutput) {
        console.log(chalk.dim(`  ${errorOutput.trim()}`));
      }
      resolvePromise(code ?? 1);
    });

    child.on('error', (err) => {
      const agentName = agent === 'codex' ? 'Codex' : 'Claude Code';
      console.log(chalk.red(`\n  Error spawning ${agentName}: ${err.message}`));
      resolvePromise(1);
    });
  });
}

// ---------------------------------------------------------------------------
// heal command
// ---------------------------------------------------------------------------

export const healCommand = new Command('heal')
  .description('Add self-healing @utopia decorators to your Python functions via Claude Code')
  .action(async () => {
    const cwd = process.cwd();

    if (!configExists(cwd)) {
      console.log(chalk.red('\n  Error: No .utopia/config.json found.'));
      console.log(chalk.dim('  Run "utopia init" first.\n'));
      process.exit(1);
    }

    const config = await loadConfig(cwd);

    // Python-only for now
    if (config.framework !== 'python' && !config.language.includes('python')) {
      console.log(chalk.red('\n  Error: utopia heal currently supports Python projects only.'));
      console.log(chalk.dim('  JS/TS support is coming soon.\n'));
      process.exit(1);
    }

    console.log(chalk.bold.cyan('\n  Utopia Self-Healing\n'));

    // Check OpenAI API key
    if (!checkOpenAIKey()) {
      console.log(chalk.yellow('  Warning: OPENAI_API_KEY is not set.'));
      console.log(chalk.dim('  Self-healing requires an OpenAI API key to generate fixes at runtime.'));
      console.log(chalk.dim('  Set it before running your app:'));
      console.log(chalk.white('    export OPENAI_API_KEY="sk-..."\n'));
    } else {
      console.log(chalk.green('  OPENAI_API_KEY detected.\n'));
    }

    // Install runtime (includes both probes and self-healing)
    console.log(chalk.dim('  Installing utopia-runtime...'));
    const rtResult = installPythonRuntime(cwd);
    if (rtResult.ok) {
      console.log(chalk.green('  utopia-runtime installed.'));
    } else {
      console.log(chalk.red(`  Error installing utopia-runtime: ${rtResult.error}`));
      console.log(chalk.dim('  The decorators won\'t work until utopia-runtime is installed.\n'));
    }

    // Check agent CLI
    const agentName = config.agent === 'codex' ? 'Codex' : 'Claude Code';
    if (!checkAgentAvailable(config.agent)) {
      console.log(chalk.red(`\n  Error: ${agentName} CLI not found.`));
      if (config.agent === 'codex') {
        console.log(chalk.dim('  Install: npm install -g @openai/codex\n'));
      } else {
        console.log(chalk.dim('  Install from: https://docs.anthropic.com/en/docs/claude-code\n'));
      }
      process.exit(1);
    }

    // Snapshot source files
    console.log(chalk.dim('  Snapshotting source files...'));
    const snapshotCount = snapshotFiles(cwd);
    console.log(chalk.dim(`  Snapshotted ${snapshotCount} file(s).\n`));

    console.log(chalk.dim(`  Launching ${agentName} to add self-healing decorators...`));
    console.log(chalk.dim(`  ${agentName} will analyze your codebase and wrap key functions with @utopia.\n`));
    console.log(chalk.bold.white(`  --- ${agentName} Session ---\n`));

    const code = await spawnAgentSession(cwd, buildHealPrompt(config), config.agent);

    console.log(chalk.bold.white(`\n  --- End ${agentName} Session ---\n`));

    // Prune unchanged snapshots
    pruneUnchangedSnapshots(cwd);

    if (code === 0) {
      console.log(chalk.bold.green('  Self-healing decorators added!\n'));
    } else {
      console.log(chalk.yellow(`  ${agentName} exited with code ${code}.\n`));
    }

    console.log(chalk.dim('  How it works:'));
    console.log(chalk.dim('    1. Your app runs normally'));
    console.log(chalk.dim('    2. When a @utopia function crashes, it auto-fixes via OpenAI'));
    console.log(chalk.dim('    3. The fix is hot-patched at runtime (your app keeps running)'));
    console.log(chalk.dim('    4. The fix is logged to .utopia/fixes/ and .utopia/FIXES.md'));
    console.log(chalk.dim('    5. Next time you open Claude Code, the fix is ready to apply permanently\n'));

    console.log(chalk.dim('  Make sure OPENAI_API_KEY is set before running your app.\n'));
  });
