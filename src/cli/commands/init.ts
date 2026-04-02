import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import crypto from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveConfig, configExists } from '../utils/config.js';
import type { UtopiaConfig, SupportedFramework, AgentType, UtopiaMode } from '../utils/config.js';

function detectLanguages(dir: string): string[] {
  const languages: Set<string> = new Set();
  const checks: Array<{ glob: string[]; lang: string }> = [
    { glob: ['tsconfig.json'], lang: 'typescript' },
    { glob: ['package.json'], lang: 'javascript' },
    { glob: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'], lang: 'python' },
  ];

  for (const check of checks) {
    for (const file of check.glob) {
      if (existsSync(resolve(dir, file))) {
        languages.add(check.lang);
      }
    }
  }

  // Scan for common file extensions in the top-level src directory
  const srcDir = resolve(dir, 'src');
  if (existsSync(srcDir)) {
    // Quick existence check for common extension patterns
    const extChecks: Array<{ ext: string; lang: string }> = [
      { ext: '.ts', lang: 'typescript' },
      { ext: '.tsx', lang: 'typescript' },
      { ext: '.js', lang: 'javascript' },
      { ext: '.jsx', lang: 'javascript' },
      { ext: '.py', lang: 'python' },
    ];
    for (const check of extChecks) {
      // If we already detected the language, skip filesystem scan
      if (!languages.has(check.lang)) {
        // We rely on config file detection above; extension scanning
        // would require walking the tree, which we skip for speed.
      }
    }
  }

  // Fallback: scan for .py files if no config-file-based detection worked for Python
  if (!languages.has('python')) {
    try {
      const entries = readdirSync(dir);
      if (entries.some(e => e.endsWith('.py'))) {
        languages.add('python');
      }
    } catch { /* ignore */ }
  }

  if (languages.size === 0) {
    languages.add('javascript');
  }

  return [...languages];
}

async function detectFramework(dir: string): Promise<string> {
  // Check package.json for JS/TS frameworks
  const packageJsonPath = resolve(dir, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const raw = await readFile(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(raw);
      const allDeps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
      };

      if (allDeps['next']) return 'nextjs';
      if (allDeps['react'] && !allDeps['next']) return 'react';
    } catch {
      // Ignore parse errors
    }
  }

  // Check Python config files
  const pythonFiles = ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py'];
  for (const file of pythonFiles) {
    if (existsSync(resolve(dir, file))) {
      return 'python';
    }
  }

  // Fallback: check for any .py files in the directory
  try {
    const entries = readdirSync(dir);
    if (entries.some(e => e.endsWith('.py'))) {
      return 'python';
    }
  } catch { /* ignore */ }

  return 'unsupported';
}

/**
 * Write Utopia environment variables to the appropriate .env file.
 * For Next.js projects, writes to .env.local with NEXT_PUBLIC_ prefixed variants.
 * For other projects, writes to .env.
 * Appends cleanly without duplicating existing variables.
 */
function writeEnvVars(cwd: string, config: UtopiaConfig): { written: number; fileName: string } {
  // Python projects read from .utopia/config.json directly — skip env vars
  // Also clean up any leftover utopia env vars from previous runs
  if (config.framework === 'python') {
    for (const envFile of ['.env', '.env.local']) {
      const envPath = resolve(cwd, envFile);
      if (existsSync(envPath)) {
        const content = readFileSync(envPath, 'utf-8');
        if (content.includes('UTOPIA_ENDPOINT') || content.includes('UTOPIA_PROJECT_ID')) {
          const cleaned = content
            .split('\n')
            .filter(line => !line.includes('UTOPIA_ENDPOINT') && !line.includes('UTOPIA_PROJECT_ID') && line.trim() !== '# Utopia probe configuration')
            .join('\n')
            .replace(/\n{3,}/g, '\n\n');
          writeFileSync(envPath, cleaned);
        }
      }
    }
    return { written: 0, fileName: '(none — Python reads .utopia/config.json)' };
  }

  const isNextJs = config.framework === 'nextjs';
  const envFileName = isNextJs ? '.env.local' : '.env';
  const envFilePath = resolve(cwd, envFileName);

  const envVars: string[] = [
    `UTOPIA_ENDPOINT=${config.dataEndpoint}`,
    `UTOPIA_PROJECT_ID=${config.projectId}`,
  ];

  // Next.js needs NEXT_PUBLIC_ variants for client components
  if (isNextJs) {
    envVars.push(
      `NEXT_PUBLIC_UTOPIA_ENDPOINT=${config.dataEndpoint}`,
      `NEXT_PUBLIC_UTOPIA_PROJECT_ID=${config.projectId}`,
    );
  }

  let existingEnv = '';
  try {
    existingEnv = readFileSync(envFilePath, 'utf-8');
  } catch {
    // File doesn't exist yet
  }

  // Replace existing Utopia env vars with current values (handles re-init)
  let updatedEnv = existingEnv;
  let changed = 0;
  for (const envVar of envVars) {
    const key = envVar.split('=')[0];
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(updatedEnv)) {
      const before = updatedEnv;
      updatedEnv = updatedEnv.replace(regex, envVar);
      if (updatedEnv !== before) changed++;
    }
  }

  // Add any vars that don't exist yet
  const missing = envVars.filter(v => {
    const key = v.split('=')[0];
    return !updatedEnv.includes(key + '=');
  });
  if (missing.length > 0) {
    const block = '\n# Utopia probe configuration\n' + missing.join('\n') + '\n';
    updatedEnv = updatedEnv ? updatedEnv + block : block.trimStart();
  }

  if (updatedEnv !== existingEnv) {
    writeFileSync(envFilePath, updatedEnv);
  }

  return { written: missing.length + changed, fileName: envFileName };
}

/**
 * Set up the Utopia MCP server for the configured agent.
 */
function setupMcpServer(cwd: string, config: UtopiaConfig): void {
  let utopiaBin = 'utopia';
  try {
    utopiaBin = execSync('which utopia', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || 'utopia';
  } catch { /* fall back to bare name */ }

  if (config.agent === 'codex') {
    try {
      execSync('codex mcp remove utopia', { cwd, stdio: 'pipe' });
    } catch { /* didn't exist */ }
    execSync(
      `codex mcp add utopia -- ${utopiaBin} mcp --endpoint ${config.dataEndpoint} --project-id ${config.projectId}`,
      { cwd, stdio: 'pipe' }
    );
  } else {
    try {
      execSync('claude mcp remove utopia', { cwd, stdio: 'pipe' });
    } catch { /* didn't exist */ }
    execSync(
      `claude mcp add utopia --scope project -- ${utopiaBin} mcp --endpoint ${config.dataEndpoint} --project-id ${config.projectId}`,
      { cwd, stdio: 'pipe' }
    );
  }
}

/**
 * Create/update the agent instructions file (CLAUDE.md or AGENTS.md)
 * with Utopia context so the agent knows about the available systems.
 * Content is generated based on utopiaMode (instrument, heal, or both).
 */
function setupAgentInstructions(cwd: string, config: UtopiaConfig): void {
  const fileName = config.agent === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
  const claudeMdPath = resolve(cwd, fileName);

  const mode = config.utopiaMode || 'instrument'; // backwards compat for old configs
  const hasProbes = mode === 'instrument' || mode === 'both';
  const hasHeal = mode === 'heal' || mode === 'both';

  // Build the title based on mode
  let title: string;
  if (mode === 'both') title = 'Production Probes + Self-Healing';
  else if (mode === 'heal') title = 'Self-Healing Functions';
  else title = 'Production Probe System';

  const sections: string[] = [];

  sections.push(`## Utopia — ${title}`);
  sections.push('');

  if (hasProbes && hasHeal) {
    sections.push('This project has Utopia installed with **two capabilities**:');
    sections.push('1. **Production probes** — real-time observability data captured from running code');
    sections.push('2. **Self-healing functions** — `@utopia` decorated functions that auto-fix errors at runtime via AI');
    sections.push('');
    sections.push('You have MCP tools to query both. **USE THEM.**');
  } else if (hasHeal) {
    sections.push('This project has Utopia self-healing installed. Functions decorated with `@utopia` automatically catch errors, generate AI-powered fixes at runtime, and log the fixes for you to apply permanently.');
    sections.push('');
    sections.push('You have MCP tools to query pending fixes. **USE THEM.**');
  } else {
    sections.push('This project has Utopia installed. It captures real-time production data via probes embedded in the code. You have MCP tools to query this data. **USE THEM.**');
  }
  sections.push('');

  // --- MANDATORY section ---
  sections.push('### MANDATORY: Check Utopia FIRST');
  sections.push('');
  sections.push('When the user asks you to investigate errors, fix bugs, build features, or modify code — your FIRST action must be to call the Utopia MCP tools. Do NOT run the app, read logs, or guess.');
  sections.push('');

  // Self-healing first-check (only if heal mode)
  if (hasHeal) {
    sections.push('**FIRST — check for self-healing fixes:**');
    sections.push('1. Call `get_pending_fixes` — if there are pending fixes, they were already debugged and solved at runtime');
    sections.push('2. For each pending fix: open the source file, replace the original code with the fixed code');
    sections.push('3. Call `mark_fix_applied` for each fix you apply');
    sections.push('4. These fixes are pre-solved bugs — apply them before doing anything else');
    sections.push('');
  }

  // Error/bug workflow
  sections.push('**When the user reports errors or bugs:**');
  const bugSteps: string[] = [];
  if (hasHeal) bugSteps.push('Call `get_pending_fixes` — the bug may already be solved by self-healing');
  if (hasProbes) bugSteps.push('Call `get_recent_errors` — this has the exact errors, stack traces, and the input data that caused them');
  if (hasProbes) bugSteps.push('Call `get_production_context` with a description of the issue');
  bugSteps.push('THEN fix the code based on what you found');
  bugSteps.forEach((step, i) => sections.push(`${i + 1}. ${step}`));
  sections.push('');

  // Starting any task (only if probes)
  if (hasProbes) {
    sections.push('**When starting any task:**');
    sections.push('1. Call `get_full_context` — comprehensive overview of production state');
    sections.push('2. Call `get_production_context` with your task description');
    sections.push('3. THEN start working');
    sections.push('');

    sections.push('**Before modifying any file:**');
    sections.push('- Call `get_production_context` with the file/function name');
    sections.push('- Call `get_impact_analysis` to see what depends on it');
    sections.push('');
  }

  // Do NOT section
  sections.push('**Do NOT:**');
  if (hasProbes) {
    sections.push('- Run the dev server just to see errors (the probes already captured them)');
    sections.push('- Guess at runtime behavior (the probes show you exactly what happens)');
    sections.push('- Skip checking probes because it seems faster (it\'s not — you\'ll miss context)');
  }
  if (hasHeal) {
    sections.push('- Manually debug an error that self-healing already fixed — check `get_pending_fixes` first');
  }
  sections.push('');

  // --- MCP Tools section ---
  sections.push('### MCP Tools');
  sections.push('');
  if (hasHeal) {
    sections.push('- `get_pending_fixes` — **CHECK FIRST** — Self-healing fixes auto-generated at runtime. Apply these before anything else.');
    sections.push('- `mark_fix_applied` — Mark a fix as permanently applied after you edit the source code');
  }
  if (hasProbes) {
    sections.push('- `get_recent_errors` — Errors with stack traces and input data that caused them');
    sections.push('- `get_production_context` — Context relevant to a specific task or file');
    sections.push('- `get_full_context` — Complete production overview (use at task start)');
    sections.push('- `get_api_context` — External API call patterns and latencies');
    sections.push('- `get_database_context` — Database query patterns and data shapes');
    sections.push('- `get_infrastructure_context` — Deployment environment details');
    sections.push('- `get_impact_analysis` — What is affected by changing a file or function');
  }
  sections.push('');

  // --- Probes management (only if instrument mode) ---
  if (hasProbes) {
    sections.push('### Adding probes — ALWAYS use utopia reinstrument');
    sections.push('');
    sections.push('**NEVER write probe code manually.** Always use the `utopia reinstrument` command to add new probes. This ensures probes are correctly formatted, tracked for clean removal, and follow all Utopia conventions.');
    sections.push('');
    sections.push('```bash');
    sections.push('utopia reinstrument -p "description of what you need deeper insight into"');
    sections.push('```');
    sections.push('');
    sections.push('Run this when:');
    sections.push('- You\'re debugging an issue but the probes don\'t cover that code path');
    sections.push('- You\'re about to refactor a module and want to understand its runtime behavior first');
    sections.push('- The user asks about a feature that doesn\'t have probes yet');
    sections.push('- You need to understand data shapes flowing through specific functions');
    sections.push('');
    sections.push('After reinstrumenting, the user needs to restart their app and trigger the code paths. Then query the MCP tools again for the new data.');
    sections.push('');
    sections.push('**Do NOT:**');
    sections.push('- Write `// utopia:probe` blocks yourself');
    sections.push('- Copy probe code from other files');
    sections.push('- Import utopia-runtime and add report calls manually');
    sections.push('These will not be tracked properly and may break `utopia destruct`.');
    sections.push('');
    sections.push('### Removing probes');
    sections.push('```bash');
    sections.push('utopia destruct');
    sections.push('```');
  }

  // --- Self-healing management (only if heal mode) ---
  if (hasHeal) {
    sections.push('### Self-healing workflow');
    sections.push('');
    sections.push('Functions decorated with `@utopia` automatically catch errors at runtime, send them to OpenAI for debugging, hot-patch the fix, and log everything to `.utopia/fixes/`.');
    sections.push('');
    sections.push('**Your job:** When you start a session, call `get_pending_fixes`. If there are fixes:');
    sections.push('1. Read each fix — it shows the file, original code, fixed code, and explanation');
    sections.push('2. Open the source file and replace the original code with the fixed code (the fixed code already includes `@utopia` decorators — do a straight replacement)');
    sections.push('3. Call `mark_fix_applied` to mark it done');
    sections.push('');
    sections.push('**Adding self-healing to more functions:**');
    sections.push('Run `utopia instrument` again (after `utopia destruct`) to re-analyze the codebase and add `@utopia` decorators.');
  }


  const utopiaSection = sections.join('\n').trim();

  // Check if CLAUDE.md exists and already has utopia section
  let existing = '';
  try {
    existing = readFileSync(claudeMdPath, 'utf-8');
  } catch { /* doesn't exist */ }

  if (existing.includes('## Utopia')) {
    // Replace existing section (matches any Utopia title variant)
    const regex = /## Utopia — [^\n]+[\s\S]*?(?=\n## |\n*$)/;
    if (regex.test(existing)) {
      const updated = existing.replace(regex, utopiaSection);
      writeFileSync(claudeMdPath, updated);
    }
  } else if (existing) {
    // Append to existing file
    writeFileSync(claudeMdPath, existing.trimEnd() + '\n\n' + utopiaSection + '\n');
  } else {
    // Create new file
    writeFileSync(claudeMdPath, utopiaSection + '\n');
  }
}

export const initCommand = new Command('init')
  .description('Initialize Utopia in your project')
  .action(async () => {
    console.log(chalk.bold.cyan(`
  ██╗   ██╗████████╗ ██████╗ ██████╗ ██╗ █████╗
  ██║   ██║╚══██╔══╝██╔═══██╗██╔══██╗██║██╔══██╗
  ██║   ██║   ██║   ██║   ██║██████╔╝██║███████║
  ██║   ██║   ██║   ██║   ██║██╔═══╝ ██║██╔══██║
  ╚██████╔╝   ██║   ╚██████╔╝██║     ██║██║  ██║
   ╚═════╝    ╚═╝    ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═╝
`));
    console.log(chalk.bold.white('  Debug AI Generated Code at Lightning Speed\n'));
    console.log(chalk.dim('  Utopia gives your AI coding agent eyes into production.'));
    console.log(chalk.dim('  It sees how your code actually runs — errors, data flow,'));
    console.log(chalk.dim('  API calls, security gaps — so the agent writes better'));
    console.log(chalk.dim('  code without you copying logs or explaining context.\n'));

    const cwd = process.cwd();

    if (configExists(cwd)) {
      const { overwrite } = await inquirer.prompt<{ overwrite: boolean }>([
        {
          type: 'confirm',
          name: 'overwrite',
          message: 'A .utopia/config.json already exists. Overwrite?',
          default: false,
        },
      ]);
      if (!overwrite) {
        console.log(chalk.yellow('\n  Setup cancelled.\n'));
        return;
      }
    }

    // Auto-detect languages and framework
    const detectedLanguages = detectLanguages(cwd);
    const detectedFramework = await detectFramework(cwd) as SupportedFramework;

    console.log(chalk.dim(`  Detected languages: ${detectedLanguages.join(', ')}`));
    console.log(chalk.dim(`  Detected framework: ${detectedFramework}\n`));

    if (detectedFramework === 'unsupported') {
      console.log(chalk.red('  Unsupported framework. Utopia currently supports:'));
      console.log(chalk.white('    - Next.js (TypeScript/JavaScript)'));
      console.log(chalk.white('    - React (TypeScript/JavaScript)'));
      console.log(chalk.white('    - Python (FastAPI, Flask, Django, etc.)\n'));
      process.exit(1);
    }

    // Agent choice
    const { agent } = await inquirer.prompt<{ agent: string }>([
      {
        type: 'list',
        name: 'agent',
        message: 'Which coding agent do you use?',
        choices: [
          { name: 'Claude Code', value: 'claude' },
          { name: 'Codex (OpenAI)', value: 'codex' },
        ],
      },
    ]);

    // Cloud provider
    const { cloudProvider } = await inquirer.prompt<{ cloudProvider: string }>([
      {
        type: 'list',
        name: 'cloudProvider',
        message: 'Where is your code deployed?',
        choices: [
          { name: 'AWS', value: 'aws' },
          { name: 'GCP', value: 'gcp' },
          { name: 'Vercel', value: 'vercel' },
          { name: 'Azure', value: 'azure' },
          { name: 'Other', value: 'other' },
        ],
      },
    ]);

    // Auto-derive service from provider
    const serviceMap: Record<string, string> = {
      aws: 'AWS',
      gcp: 'GCP',
      vercel: 'Vercel',
      azure: 'Azure',
      other: 'Other',
    };
    const service = serviceMap[cloudProvider] || cloudProvider;

    // Step 2: Deployment method
    const { deploymentMethod } = await inquirer.prompt<{ deploymentMethod: string }>([
      {
        type: 'list',
        name: 'deploymentMethod',
        message: 'How is your code deployed?',
        choices: [
          { name: 'Manual', value: 'manual' },
          { name: 'GitHub Actions', value: 'github-actions' },
          { name: 'Vercel Trigger', value: 'vercel-trigger' },
          { name: 'Other', value: 'other' },
        ],
      },
    ]);

    // Step 4: Standalone repository
    const { isStandalone } = await inquirer.prompt<{ isStandalone: boolean }>([
      {
        type: 'confirm',
        name: 'isStandalone',
        message: 'Is this repository standalone? (No = used by other repos)',
        default: true,
      },
    ]);

    // Utopia mode — what capabilities to enable
    const modeChoices = [
      { name: 'Production probes (observability — see how code runs in production)', value: 'instrument' },
      { name: 'Self-healing functions (auto-fix errors at runtime via AI)', value: 'heal' },
      { name: 'Both — probes + self-healing', value: 'both' },
    ];

    const modeAnswer = await inquirer.prompt<{ utopiaMode: string }>([
      {
        type: 'list',
        name: 'utopiaMode',
        message: 'What capabilities do you want?',
        choices: modeChoices,
      },
    ]);
    const utopiaMode = modeAnswer.utopiaMode;

    const wantsProbes = utopiaMode === 'instrument' || utopiaMode === 'both';
    const wantsHeal = utopiaMode === 'heal' || utopiaMode === 'both';

    // Data collection depth (only relevant for probes)
    let dataMode = 'schemas';
    if (wantsProbes) {
      const dataModeAnswer = await inquirer.prompt<{ dataMode: string }>([
        {
          type: 'list',
          name: 'dataMode',
          message: 'What level of data should probes capture?',
          choices: [
            { name: 'Schemas & shapes only (counts, types, field names — no actual user data)', value: 'schemas' },
            { name: 'Full data context (real inputs, outputs, DB results — maximum visibility)', value: 'full' },
          ],
        },
      ]);
      dataMode = dataModeAnswer.dataMode;
    }

    // Probe goal (only relevant for probes)
    let probeGoal = 'debugging';
    if (wantsProbes) {
      const probeGoalAnswer = await inquirer.prompt<{ probeGoal: string }>([
        {
          type: 'list',
          name: 'probeGoal',
          message: 'What are you looking to solve?',
          choices: [
            { name: 'Debugging — runtime behavior, errors, data flow, performance', value: 'debugging' },
            { name: 'Security — SQL injection, auth flaws, insecure patterns, bad domains', value: 'security' },
            { name: 'Both — full debugging + security analysis', value: 'both' },
          ],
        },
      ]);
      probeGoal = probeGoalAnswer.probeGoal;
    }

    const dataEndpoint = 'http://localhost:7890';
    const projectId = `proj_${crypto.randomBytes(8).toString('hex')}`;

    const config: UtopiaConfig = {
      version: '0.1.0',
      projectId,
      cloudProvider,
      service: service.trim(),
      deploymentMethod,
      isStandalone,
      dataEndpoint,
      language: detectedLanguages,
      framework: detectedFramework,
      dataMode: dataMode as UtopiaConfig['dataMode'],
      probeGoal: probeGoal as UtopiaConfig['probeGoal'],
      agent: agent as AgentType,
      utopiaMode: utopiaMode as UtopiaMode,
    };

    await saveConfig(config, cwd);

    // Write environment variables to the appropriate .env file
    try {
      const { written, fileName } = writeEnvVars(cwd, config);
      if (written > 0) {
        console.log(chalk.green(`\n  Added ${written} environment variable(s) to ${fileName}`));
      } else {
        console.log(chalk.dim(`\n  Environment variables already present in ${fileName}`));
      }
    } catch (err) {
      console.log(chalk.yellow(`\n  Could not write environment variables: ${(err as Error).message}`));
      console.log(chalk.dim('  You can set them manually:'));
      console.log(chalk.dim(`    UTOPIA_ENDPOINT=${config.dataEndpoint}`));
      console.log(chalk.dim(`    UTOPIA_PROJECT_ID=${config.projectId}`));
    }

    // Set up MCP server for the chosen agent
    const agentLabel = config.agent === 'codex' ? 'Codex' : 'Claude Code';
    try {
      setupMcpServer(cwd, config);
      console.log(chalk.green(`\n  MCP server configured for ${agentLabel}`));
    } catch (err) {
      console.log(chalk.yellow(`\n  Could not configure MCP server: ${(err as Error).message}`));
    }

    try {
      setupAgentInstructions(cwd, config);
      const instrFile = config.agent === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
      console.log(chalk.green(`  ${instrFile} updated with Utopia instructions`));
    } catch (err) {
      console.log(chalk.yellow(`  Could not update agent instructions: ${(err as Error).message}`));
    }

    // Print summary
    console.log(chalk.bold.green('\n  Utopia initialized successfully!\n'));
    console.log(chalk.white('  Configuration saved to .utopia/config.json'));
    console.log(chalk.dim('  (.utopia/ is gitignored by default)\n'));

    const modeLabel = utopiaMode === 'both' ? 'Probes + Self-Healing'
      : utopiaMode === 'heal' ? 'Self-Healing' : 'Production Probes';

    console.log(chalk.bold('  Project Summary:'));
    console.log(`    Project ID:   ${chalk.cyan(projectId)}`);
    console.log(`    Mode:         ${chalk.cyan(modeLabel)}`);
    console.log(`    Provider:     ${chalk.cyan(cloudProvider)}`);
    console.log(`    Deploy via:   ${chalk.cyan(deploymentMethod)}`);
    console.log(`    Languages:    ${chalk.cyan(detectedLanguages.join(', '))}`);
    console.log(`    Framework:    ${chalk.cyan(detectedFramework)}`);
    console.log(`    Agent:        ${chalk.cyan(agent === 'codex' ? 'Codex (OpenAI)' : 'Claude Code')}`);
    if (wantsProbes) {
      console.log(`    Data mode:    ${chalk.cyan(dataMode === 'full' ? 'Full data context' : 'Schemas & shapes only')}`);
      console.log(`    Probe goal:   ${chalk.cyan(probeGoal === 'both' ? 'Debugging + Security' : probeGoal.charAt(0).toUpperCase() + probeGoal.slice(1))}`);
    }

    console.log(chalk.bold('\n  Next Steps:\n'));
    let step = 1;
    const modeDesc = wantsProbes && wantsHeal ? 'probes + self-healing'
      : wantsHeal ? 'self-healing decorators' : 'production probes';
    console.log(`    ${step}. ${chalk.white('utopia instrument')}   — Add ${modeDesc} to your codebase`);
    step++;
    if (wantsProbes) {
      console.log(`    ${step}. ${chalk.white('utopia validate')}     — Verify probes are valid`);
      step++;
      console.log(`    ${step}. ${chalk.white('utopia serve -b')}     — Start the data service`);
      step++;
    }
    if (wantsHeal) {
      const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
      const hasOpenAI = !!process.env.OPENAI_API_KEY;
      if (hasAnthropic || hasOpenAI) {
        const keyName = hasAnthropic && !hasOpenAI ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
        console.log(chalk.dim(`    ${step}. ${keyName} detected — self-healing is ready`));
      } else {
        console.log(`    ${step}. ${chalk.white('export OPENAI_API_KEY="sk-..."')}  or  ${chalk.white('export ANTHROPIC_API_KEY="sk-ant-..."')}`);
      }
      step++;
    }
    console.log(`    ${step}. Run your app and browse around`);
    step++;
    if (wantsProbes) {
      console.log(`    ${step}. ${chalk.white('utopia status')}       — See probe data flowing`);
    }
    console.log('');
  });
