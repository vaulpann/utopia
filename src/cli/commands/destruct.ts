import { Command } from 'commander';
import chalk from 'chalk';
import { resolve, dirname } from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, mkdirSync, unlinkSync } from 'node:fs';
import { configExists, loadConfig } from '../utils/config.js';
import type { UtopiaConfig } from '../utils/config.js';

const SNAPSHOT_DIR = '.utopia/snapshots';
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.utopia', '.git', '__pycache__', 'venv', '.venv', 'coverage', '.env', 'env']);

// ---------------------------------------------------------------------------
// Heal stripping (regex — works reliably for decorators)
// ---------------------------------------------------------------------------

/**
 * Strip @utopia decorators and utopia_runtime self-healing imports from Python content.
 */
function stripHealFromContent(content: string): string {
  let result = content;

  result = result.replace(/^\s*@utopia\b[^\n]*\n/gm, '');
  result = result.replace(/^\s*from\s+utopia_runtime\s+import\s+utopia\b[^\n]*\n/gm, '');
  result = result.replace(/^\s*from\s+utopia_sdk\s+import\s+[^\n]+\n/gm, '');

  result = result.replace(/\n{3,}/g, '\n\n');
  result = result.replace(/[ \t]+$/gm, '');

  return result;
}

/**
 * Strip utopia() wrappers from JS/TS content.
 */
function stripJsHealFromContent(content: string): string {
  let result = content;

  // Remove utopia() wrapper calls:
  //   const foo = utopia(async (...) => { ... }, { name: 'foo' });
  //   → const foo = async (...) => { ... };
  // This is a best-effort regex — the agent handles complex cases
  result = result.replace(/utopia\(\s*((?:async\s+)?(?:function|\(|[a-zA-Z_$]))/g, '$1');
  // Remove trailing , { name: '...' }) or , { ignore: [...] })
  // and remove trailing , { ... }) option objects — too complex for regex, leave for agent

  // Remove import of utopia from utopia-runtime if no utopia() calls remain
  if (!result.includes('utopia(')) {
    result = result.replace(/,\s*utopia\b/g, '');
    result = result.replace(/\butopia\s*,\s*/g, '');
    // If utopia was the only import
    result = result.replace(/import\s*\{\s*utopia\s*\}\s*from\s*['"]utopia-runtime['"];?\s*\n?/g, '');
  }

  result = result.replace(/\n{3,}/g, '\n\n');
  return result;
}

function collectFiles(dir: string, exts: Set<string>): string[] {
  const results: string[] = [];
  function walk(d: string): void {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;
      const full = resolve(d, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (st.isFile()) {
          const ext = full.substring(full.lastIndexOf('.'));
          if (exts.has(ext)) results.push(full);
        }
      } catch { /* skip */ }
    }
  }
  walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Agent-based probe removal
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

function buildDestructProbePrompt(config: UtopiaConfig): string {
  const isPython = config.framework === 'python';

  if (isPython) {
    return `You are removing all Utopia probes from this Python codebase. This is a clean removal — preserve all non-probe code exactly as-is.

## What to remove

1. **Every \`# utopia:probe\` block** — the comment line, the \`try:\` block that follows it, and the \`except Exception: pass\` that closes it. Remove the ENTIRE block.

2. **Every \`_utopia_start = time.time()\` line** — these are timing variables used by probes.

3. **\`import utopia_runtime\`** — remove this import line IF no other utopia_runtime usage remains in the file after removing probes. Check first.

4. **\`import time\`** — remove this import line ONLY IF time is not used anywhere else in the file after removing probes. Check first.

5. **\`import os\`** — remove this import line ONLY IF os is not used anywhere else in the file after removing probes. Check first.

## What to KEEP

- ALL non-probe code — function logic, user code, business logic
- \`@utopia\` decorators (those are self-healing, not probes)
- \`from utopia_runtime import utopia\` (that's for self-healing, not probes)
- Any code the user wrote that isn't a probe

## How to identify probe blocks

Probes always follow this exact pattern:

\`\`\`python
# utopia:probe — some description
try:
    utopia_runtime.report_function(
        ...
    )
except Exception:
    pass
\`\`\`

Or with \`report_error\`, \`report_api\`, \`report_db\`, \`report_infra\`.

The \`# utopia:probe\` comment is the reliable marker. Every probe has one.

## Your task

1. Find all files with \`# utopia:probe\` or \`import utopia_runtime\`
2. Remove every probe block and timing variable
3. Clean up imports that are no longer needed
4. Clean up any resulting double blank lines
5. Give a summary of what you removed and from which files`;
  }

  // JS/TS
  return `You are removing all Utopia probes from this JavaScript/TypeScript codebase. This is a clean removal — preserve all non-probe code exactly as-is.

## What to remove

1. **Every \`// utopia:probe\` block** — the comment line and the \`try { ... } catch { /* probe error */ }\` block that follows it. Remove the ENTIRE block.

2. **Every \`const __utopia_start = Date.now();\` line** — timing variables used by probes.

3. **\`import { __utopia } from 'utopia-runtime';\`** — remove this import IF no other __utopia usage remains in the file. Check first.

## What to KEEP

- ALL non-probe code
- \`utopia()\` wrapper calls (those are self-healing, not probes)
- Any import of \`utopia\` (not \`__utopia\`) from 'utopia-runtime'

## How to identify probe blocks

Probes always follow this pattern:

\`\`\`javascript
// utopia:probe
try {
  __utopia.reportFunction({ ... });
} catch { /* probe error — swallow silently */ }
\`\`\`

The \`// utopia:probe\` comment is the reliable marker.

## Your task

1. Find all files with \`// utopia:probe\` or \`__utopia\` imports
2. Remove every probe block and timing variable
3. Clean up imports that are no longer needed
4. Clean up any resulting double blank lines
5. Give a summary of what you removed and from which files`;
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
        process.stdout.write(`\r  ${frames[frame % frames.length]} Codex is removing probes... (${timeStr})  `);
        frame++;
      }, 100);
      child.on('close', () => { clearInterval(spinner); process.stdout.write('\r' + ' '.repeat(60) + '\r'); });
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

    try { unlinkSync(tmpPromptFile); } catch { /* ignore */ }

    let errorOutput = '';
    let filesEdited = 0;

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
                  console.log(chalk.green(`  [${filesEdited}] Cleaned: ${fp}`));
                }
              }
            }
          }
          if (msg.type === 'result' && msg.result) {
            console.log('\n' + chalk.white(msg.result));
          }
        } catch { /* partial JSON */ }
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
// destruct command
// ---------------------------------------------------------------------------

export const destructCommand = new Command('destruct')
  .description('Remove all Utopia probes and self-healing decorators from the codebase')
  .option('--dry-run', 'Show what would be restored without changing files', false)
  .action(async (options) => {
    const cwd = process.cwd();

    if (!configExists(cwd)) {
      console.log(chalk.red('\n  Error: No .utopia/config.json found.\n'));
      process.exit(1);
    }

    const config: UtopiaConfig = await loadConfig(cwd);
    const mode = config.utopiaMode || 'instrument';
    const hasProbes = mode === 'instrument' || mode === 'both';
    const hasHeal = mode === 'heal' || mode === 'both';

    console.log(chalk.bold.cyan('\n  Utopia Destruct\n'));

    if (options.dryRun) {
      console.log(chalk.yellow('  Dry run — no files will be modified.\n'));
    }

    if (hasProbes) console.log(chalk.dim('  Mode: removing production probes'));
    if (hasHeal) console.log(chalk.dim('  Mode: removing @utopia self-healing decorators'));
    console.log('');

    // --- Phase 1: Strip @utopia decorators (regex — fast and reliable) ---

    if (hasHeal && !options.dryRun) {
      const isPython = config.framework === 'python';
      const exts = isPython ? new Set(['.py']) : new Set(['.ts', '.tsx', '.js', '.jsx']);
      const files = collectFiles(cwd, exts);
      let healStripped = 0;

      for (const file of files) {
        const content = readFileSync(file, 'utf-8');
        const stripped = isPython ? stripHealFromContent(content) : stripJsHealFromContent(content);
        if (stripped !== content) {
          writeFileSync(file, stripped);
          const rel = file.substring(cwd.length + 1);
          console.log(chalk.green(`  Stripped @utopia: ${rel}`));
          healStripped++;
        }
      }

      if (healStripped > 0) {
        console.log(chalk.dim(`  Removed self-healing decorators from ${healStripped} file(s).\n`));
      } else {
        console.log(chalk.dim('  No @utopia decorators found.\n'));
      }
    }

    // --- Phase 2: Remove probes via AI agent ---

    if (hasProbes && !options.dryRun) {
      const agentName = config.agent === 'codex' ? 'Codex' : 'Claude Code';

      if (!checkAgentAvailable(config.agent)) {
        console.log(chalk.red(`  Error: ${agentName} CLI not found.`));
        console.log(chalk.dim('  Cannot remove probes without the AI agent.\n'));
      } else {
        console.log(chalk.dim(`  Launching ${agentName} to remove production probes...\n`));
        console.log(chalk.bold.white(`  --- ${agentName} Session ---\n`));

        const code = await spawnAgentSession(cwd, buildDestructProbePrompt(config), config.agent);

        console.log(chalk.bold.white(`\n  --- End ${agentName} Session ---\n`));

        if (code === 0) {
          console.log(chalk.bold.green('  Probes removed.\n'));
        } else {
          console.log(chalk.yellow(`  ${agentName} exited with code ${code}.\n`));
        }
      }
    }

    if (options.dryRun) {
      console.log(chalk.yellow('  Dry run complete. No files were modified.\n'));
      return;
    }

    // --- Phase 3: Cleanup ---

    // Remove snapshots
    const snapshotBase = resolve(cwd, SNAPSHOT_DIR);
    if (existsSync(snapshotBase)) {
      try {
        rmSync(snapshotBase, { recursive: true, force: true });
        console.log(chalk.dim('  Removed snapshots.'));
      } catch { /* ignore */ }
    }

    // Clean up copied Python runtime dir
    if (hasProbes) {
      const pythonRuntimeDir = resolve(cwd, 'utopia_runtime');
      if (existsSync(pythonRuntimeDir)) {
        try {
          rmSync(pythonRuntimeDir, { recursive: true, force: true });
          console.log(chalk.dim('  Removed utopia_runtime/ directory.'));
        } catch { /* ignore */ }
      }
    }

    // Clean up self-healing artifacts
    if (hasHeal) {
      const fixesDir = resolve(cwd, '.utopia', 'fixes');
      if (existsSync(fixesDir)) {
        try {
          rmSync(fixesDir, { recursive: true, force: true });
          console.log(chalk.dim('  Removed .utopia/fixes/ directory.'));
        } catch { /* ignore */ }
      }

      const fixesMd = resolve(cwd, '.utopia', 'FIXES.md');
      if (existsSync(fixesMd)) {
        try {
          rmSync(fixesMd, { force: true });
          console.log(chalk.dim('  Removed .utopia/FIXES.md'));
        } catch { /* ignore */ }
      }
    }

    console.log(chalk.bold.green('\n  Destruct complete.\n'));
  });
