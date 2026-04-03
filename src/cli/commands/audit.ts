import { Command } from 'commander';
import chalk from 'chalk';
import { resolve, dirname } from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { loadConfig, configExists } from '../utils/config.js';
import type { UtopiaConfig } from '../utils/config.js';

// ---------------------------------------------------------------------------
// Helpers
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

async function fetchJSON(url: string, method: 'GET' | 'POST' = 'GET'): Promise<unknown> {
  try {
    const response = await fetch(url, {
      method,
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// AI-powered deep analysis prompt
// ---------------------------------------------------------------------------

function buildAuditPrompt(probeSummary: string, _unused?: string): string {
  return `You are a senior application security researcher performing a runtime security audit. You have access to REAL production data captured by Utopia probes — this is not static analysis. You are seeing actual API calls, database queries, auth decisions, error patterns, and data flows from a running application.

## Runtime Probe Data

This is actual production data captured from the running application. Analyze it for security vulnerabilities:

${probeSummary}

## Your Analysis

Look for these categories of vulnerabilities. For each finding, provide:
- **Severity**: critical / high / medium / low
- **Title**: one-line description
- **Evidence**: specific data from the probes that proves the vulnerability
- **Fix**: concrete recommendation

### What to look for:

1. **Data exposure** — Are sensitive fields (passwords, tokens, PII) appearing in API responses, logs, or error messages? Look at return values and response shapes.

2. **Auth/authz gaps** — Are there endpoints handling sensitive data without auth checks? Are auth decisions inconsistent (sometimes checked, sometimes not)?

3. **Injection vectors** — Are database queries built with string concatenation? Is user input flowing into commands/queries without sanitization?

4. **Business logic flaws** — Can negative discounts create money? Can users access other users' data? Are there race conditions in financial operations?

5. **Data flow issues** — Is encrypted data being sent over HTTP? Are internal service URLs or credentials leaking into client responses?

6. **Configuration risks** — Debug mode in production? Overly permissive CORS? Missing rate limiting on auth endpoints?

7. **Error handling** — Are internal error details (stack traces, file paths, DB schemas) exposed to clients?

8. **API security** — Are there endpoints with no rate limiting? Missing CSRF protection? Accepting unexpected content types?

## IMPORTANT: Ignore Utopia's own code

Do NOT report findings about Utopia's own instrumentation code. This includes:
- \`// utopia:probe\` blocks and their \`try/catch\` wrappers
- \`__utopia.reportFunction()\`, \`__utopia.reportError()\`, \`__utopia.reportApi()\`, \`__utopia.reportInfra()\` calls
- \`utopia()\` self-healing wrappers and \`@utopia\` decorators
- \`import { __utopia } from 'utopia-runtime'\` and \`import utopia_runtime\`
- \`_utopia_start\` timing variables
- Any data being sent to \`UTOPIA_ENDPOINT\` or \`localhost:7890\`
- The \`.utopia/\` directory and its contents

Utopia is a development/debugging tool that gets completely removed before production deployment via \`utopia destruct\`. It is NOT part of the application's production code. Reporting Utopia's own behavior as a vulnerability is a false positive — skip it entirely and focus on the application's actual code.

Be specific. Reference actual probe data as evidence. Don't speculate — if the data doesn't show a vulnerability, don't report one.

Respond with a structured report. For each finding:

\`\`\`
## [SEVERITY] Title

**Evidence:** What specific probe data shows this
**Impact:** What an attacker could do
**Fix:** Concrete fix recommendation
**File:** Which file(s) are affected
\`\`\`

## IMPORTANT: Save findings to JSON

After your analysis, write ALL findings to a JSON file at \`.utopia/security/ai-findings.json\`. The file must be a JSON array of objects with this exact schema:

\`\`\`json
[
  {
    "severity": "critical|high|medium|low",
    "title": "One-line title",
    "description": "Full description with evidence",
    "file": "path/to/file.ts",
    "function_name": "functionName",
    "evidence": "Key evidence from probe data"
  }
]
\`\`\`

This is required so the findings are available to agents via MCP tools. Do not skip this step.`;
}

// ---------------------------------------------------------------------------
// Agent session for deep analysis
// ---------------------------------------------------------------------------

function spawnAgentSession(cwd: string, prompt: string, agent: string): Promise<number> {
  return new Promise<number>((resolvePromise) => {
    let child: ReturnType<typeof spawn>;

    const tmpPromptFile = resolve(cwd, '.utopia', '.audit-prompt.tmp');
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
        process.stdout.write(`\r  ${frames[frame % frames.length]} Analyzing security... (${timeStr})  `);
        frame++;
      }, 100);
      child.on('close', () => { clearInterval(spinner); process.stdout.write('\r' + ' '.repeat(60) + '\r'); });
    } else {
      child = spawn('claude', [
        '-p', prompt,
        '--allowedTools', 'Read,Grep,Glob,Bash',
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
    let fullOutput = '';

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      fullOutput += text;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text) {
                process.stdout.write(chalk.dim(block.text));
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
// audit command
// ---------------------------------------------------------------------------

export const auditCommand = new Command('audit')
  .description('Run a security audit against your production probe data')
  .option('--hours <hours>', 'Hours of probe data to analyze', '168')
  .action(async (options) => {
    const cwd = process.cwd();

    if (!configExists(cwd)) {
      console.log(chalk.red('\n  Error: No .utopia/config.json found.'));
      console.log(chalk.dim('  Run "utopia init" first.\n'));
      process.exit(1);
    }

    const config = await loadConfig(cwd);
    const endpoint = config.dataEndpoint || 'http://localhost:7890';
    const hours = parseInt(options.hours, 10);

    console.log(chalk.bold.cyan('\n  Utopia Security Audit\n'));

    // Check data service
    console.log(chalk.dim('  Checking data service...'));
    const health = await fetchJSON(`${endpoint}/api/v1/health`);
    if (!health) {
      console.log(chalk.red('  Error: Utopia data service is not running.'));
      console.log(chalk.dim('  Start it with: utopia serve -b\n'));
      process.exit(1);
    }
    console.log(chalk.green('  Data service is running.\n'));

    // AI-powered deep analysis
    const agentName = config.agent === 'codex' ? 'Codex' : 'Claude Code';

    if (!checkAgentAvailable(config.agent)) {
      console.log(chalk.red(`  Error: ${agentName} CLI not found.\n`));
      process.exit(1);
    }

    // Get probe summary for AI
    console.log(chalk.dim('  Fetching probe data for analysis...'));
    const probeSummary = await fetchJSON(`${endpoint}/api/v1/security/probe-summary?hours=${hours}`);

    if (!probeSummary) {
      console.log(chalk.yellow('  Could not fetch probe data. Make sure your app has been running with probes.\n'));
      return;
    }

    const probeSummaryStr = JSON.stringify(probeSummary, null, 2).substring(0, 50000);

    console.log(chalk.dim(`\n  Launching ${agentName} for security analysis...`));
    console.log(chalk.dim(`  ${agentName} will analyze runtime patterns for vulnerabilities static analysis can't find.\n`));
    console.log(chalk.bold.white(`  --- ${agentName} Security Analysis ---\n`));

    const code = await spawnAgentSession(
      cwd,
      buildAuditPrompt(probeSummaryStr, ''),
      config.agent,
    );

    console.log(chalk.bold.white(`\n  --- End Security Analysis ---\n`));

    // Phase 3: Store AI findings in the data service
    const aiFindingsPath = resolve(cwd, '.utopia', 'security', 'ai-findings.json');
    if (existsSync(aiFindingsPath)) {
      try {
        const aiFindings = JSON.parse(readFileSync(aiFindingsPath, 'utf-8')) as Array<{
          severity: string;
          title: string;
          description: string;
          file?: string;
          function_name?: string;
          evidence?: string;
        }>;

        let stored = 0;
        for (const finding of aiFindings) {
          const sev = finding.severity?.toLowerCase();
          if (!['critical', 'high', 'medium', 'low', 'info'].includes(sev)) continue;

          try {
            // POST to the security findings endpoint via scan (which deduplicates)
            // Use the findings GET endpoint to check if it already exists, then POST directly
            const res = await fetch(`${endpoint}/api/v1/security/findings`, {
              method: 'GET',
              headers: { 'Accept': 'application/json' },
              signal: AbortSignal.timeout(5_000),
            });
            const existing = await res.json() as { findings: Array<{ title: string }> };
            const alreadyExists = existing.findings?.some(f => f.title === finding.title);

            if (!alreadyExists) {
              // Insert directly via a custom POST
              await fetch(`${endpoint}/api/v1/security/findings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  rule_id: 'ai-audit',
                  severity: sev,
                  title: finding.title,
                  description: finding.description,
                  file: finding.file || '',
                  function_name: finding.function_name || '',
                  evidence: finding.evidence || '',
                }),
                signal: AbortSignal.timeout(5_000),
              });
              stored++;
            }
          } catch { /* non-fatal */ }
        }

        if (stored > 0) {
          console.log(chalk.green(`  ${stored} AI finding(s) stored in data service.\n`));
        } else {
          console.log(chalk.dim('  AI findings already in data service (or none to store).\n'));
        }
      } catch {
        console.log(chalk.dim('  Could not parse AI findings JSON.\n'));
      }
    }

    if (code === 0) {
      console.log(chalk.bold.green('  Security audit complete.\n'));
    } else {
      console.log(chalk.yellow(`  ${agentName} exited with code ${code}.\n`));
    }
  });
