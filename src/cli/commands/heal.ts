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

function installJsRuntime(cwd: string): { ok: boolean; error?: string } {
  let pm = 'npm';
  if (existsSync(resolve(cwd, 'pnpm-lock.yaml'))) pm = 'pnpm';
  else if (existsSync(resolve(cwd, 'yarn.lock'))) pm = 'yarn';

  try {
    execSync(`${pm} add utopia-runtime 2>&1`, { cwd, stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `${pm} add utopia-runtime failed: ${(err as Error).message}` };
  }
}

function checkOpenAIKey(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

// ---------------------------------------------------------------------------
// Prompt for the agent
// ---------------------------------------------------------------------------

function buildHealPrompt(config: UtopiaConfig): string {
  const isPython = config.framework === 'python';

  if (isPython) {
    return buildPythonHealPrompt();
  }
  return buildJsHealPrompt();
}

function buildPythonHealPrompt(): string {
  return `You are adding self-healing capabilities to a Python codebase using utopia-runtime.

The \`@utopia\` decorator wraps Python functions with automatic error recovery. When a decorated function throws an exception at runtime:

1. The error and function source code are sent to OpenAI or Anthropic
2. The AI generates a fix
3. The fix is hot-patched and re-executed at runtime
4. The fix is logged to \`.utopia/fixes/\` so the next coding agent can apply it permanently

## How to import

\`\`\`python
from utopia_runtime import utopia
\`\`\`

## Usage

\`\`\`python
@utopia
def process_payment(order_id: str, amount: float):
    ...

@utopia
async def fetch_user_data(user_id: str):
    ...

@utopia(ignore=[ValueError, KeyError])
def strict_parser(data: str):
    if not data:
        raise ValueError("data is required")  # intentional — passes through
    return json.loads(data)  # unexpected errors self-heal
\`\`\`

## Intentional vs unexpected errors

Use \`ignore\` for exception types the function raises **on purpose** (validation, not-found, auth errors). Everything else triggers self-healing.

## Your Task

1. **Explore the codebase.** Find all Python files, identify the important functions.

2. **Add \`@utopia\` to functions where runtime errors matter:**
   - API route handlers / endpoint handlers
   - Functions processing external data (API responses, user input, file parsing)
   - Database interactions (queries, mutations)
   - External service / API calls
   - Business logic (payments, transformations, calculations)
   - Auth / authorization functions
   - Data processing / ETL
   - CLI command handlers, background tasks, webhooks

   **DO NOT decorate:**
   - Tiny utility functions (string formatting, simple getters)
   - Type definitions or constants
   - Test functions
   - \`__init__\`, \`__repr__\`, \`__str__\` and similar dunder methods
   - Third-party or generated code

3. **Add the import** to every file: \`from utopia_runtime import utopia\`

4. **Placement:** \`@utopia\` goes BELOW other decorators (outermost wrapper):
   \`\`\`python
   @app.route("/users")
   @require_auth
   @utopia
   def get_users():
       ...
   \`\`\`

5. **Use \`ignore\`** when a function intentionally raises (e.g. \`@utopia(ignore=[ValueError])\`)

6. **Give a summary** of what you decorated and why. Group by file.`;
}

function buildJsHealPrompt(): string {
  return `You are adding self-healing capabilities to a JavaScript/TypeScript codebase using utopia-runtime.

The \`utopia()\` wrapper wraps functions with automatic error recovery. When a wrapped function throws an exception at runtime:

1. The error and function source are sent to OpenAI or Anthropic
2. The AI generates a fix
3. For async functions: the fix is hot-patched and re-executed at runtime
4. For sync functions: the fix is logged for the next run
5. Everything is logged to \`.utopia/fixes/\` so the next coding agent can apply it permanently

## How to import

\`\`\`typescript
import { utopia } from 'utopia-runtime';
\`\`\`

## Usage

\`\`\`typescript
// Wrap a function — works with named functions, arrows, async
const processPayment = utopia(async (orderId: string, amount: number) => {
  const charge = await stripe.charges.create({ amount, currency: 'usd' });
  return charge.id;
});

// With a name (helps with fix logging)
const fetchUser = utopia(async (userId: string) => {
  const res = await fetch(\`/api/users/\${userId}\`);
  return res.json();
}, { name: 'fetchUser' });

// Ignore intentional errors
const strictParse = utopia((data: string) => {
  if (!data) throw new TypeError('data required');  // intentional — passes through
  return JSON.parse(data);  // unexpected errors self-heal
}, { ignore: [TypeError] });
\`\`\`

## How it works

- \`utopia(fn)\` returns a wrapped version of \`fn\` with the same signature
- Async functions get full hot-patching (fix is compiled and re-run immediately)
- Sync functions log the fix for the next run (can't await AI call synchronously)
- The \`ignore\` option accepts an array of Error subclasses that pass through without healing
- The \`name\` option sets the function name for fix logging (auto-detected from \`fn.name\` if available)

## Your Task

1. **Explore the codebase.** Find all source files, identify the important functions.

2. **Wrap functions where runtime errors matter with \`utopia()\`:**
   - API route handlers / endpoint handlers / server actions
   - Functions processing external data (API responses, user input, file parsing)
   - Database interactions
   - External service / API calls
   - Business logic (payments, transformations, calculations)
   - Auth / authorization functions
   - Data processing, background jobs, webhooks
   - React Server Components that fetch data

   **DO NOT wrap:**
   - Tiny utility functions (string formatting, simple getters)
   - Type definitions or constants
   - Test functions
   - React client components (wrap the data-fetching functions they call instead)
   - Third-party or generated code
   - Functions that are already inside a utopia wrapper

3. **Add the import** to every file: \`import { utopia } from 'utopia-runtime';\`
   - Check if it's already imported first

4. **Wrapping patterns:**

   **Named export function:**
   \`\`\`typescript
   // Before
   export async function getUser(id: string) { ... }
   // After
   export const getUser = utopia(async (id: string) => { ... }, { name: 'getUser' });
   \`\`\`

   **Default export:**
   \`\`\`typescript
   // Before
   export default async function handler(req, res) { ... }
   // After
   const handler = utopia(async (req, res) => { ... }, { name: 'handler' });
   export default handler;
   \`\`\`

   **Arrow in variable:**
   \`\`\`typescript
   // Before
   const processData = async (data) => { ... };
   // After
   const processData = utopia(async (data) => { ... }, { name: 'processData' });
   \`\`\`

5. **Use \`ignore\`** when a function intentionally throws (e.g. \`{ ignore: [TypeError, RangeError] }\`)

6. **Give a summary** of what you wrapped and why. Group by file.`;
}

// ---------------------------------------------------------------------------
// File snapshotting (same pattern as instrument.ts)
// ---------------------------------------------------------------------------

const SNAPSHOT_DIR = '.utopia/snapshots';
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.utopia', '.git', '__pycache__', 'venv', '.venv', 'coverage', '.env', 'env']);
const SOURCE_EXTS = new Set(['.py', '.ts', '.tsx', '.js', '.jsx']);

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
    const isPython = config.framework === 'python' || config.language.includes('python');
    const isJs = !isPython;

    console.log(chalk.bold.cyan('\n  Utopia Self-Healing\n'));

    // Check for API keys (OpenAI or Anthropic)
    if (!checkOpenAIKey() && !process.env.ANTHROPIC_API_KEY) {
      console.log(chalk.yellow('  Warning: No AI API key detected.'));
      console.log(chalk.dim('  Self-healing requires an API key to generate fixes at runtime.'));
      console.log(chalk.dim('  Set one before running your app:'));
      console.log(chalk.white('    export OPENAI_API_KEY="sk-..."'));
      console.log(chalk.white('    export ANTHROPIC_API_KEY="sk-ant-..."\n'));
    } else {
      const provider = process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY ? 'Anthropic' : 'OpenAI';
      console.log(chalk.green(`  ${provider} API key detected.\n`));
    }

    // Install runtime
    if (isPython) {
      console.log(chalk.dim('  Installing utopia-runtime (Python)...'));
      const rtResult = installPythonRuntime(cwd);
      if (rtResult.ok) {
        console.log(chalk.green('  utopia-runtime installed.'));
      } else {
        console.log(chalk.red(`  Error installing utopia-runtime: ${rtResult.error}`));
        console.log(chalk.dim('  The decorators won\'t work until utopia-runtime is installed.\n'));
      }
    } else {
      console.log(chalk.dim('  Installing utopia-runtime (JS/TS)...'));
      const rtResult = installJsRuntime(cwd);
      if (rtResult.ok) {
        console.log(chalk.green('  utopia-runtime installed.'));
      } else {
        console.log(chalk.red(`  Error installing utopia-runtime: ${rtResult.error}`));
        console.log(chalk.dim('  The wrapper won\'t work until utopia-runtime is installed.\n'));
      }
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
