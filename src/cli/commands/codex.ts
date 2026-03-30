import { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'node:child_process';
import { loadConfig, configExists } from '../utils/config.js';

interface ContextResponse {
  count: number;
  keywords?: string[];
  probes: Array<{
    id: string;
    projectId: string;
    probeType: string;
    timestamp: string;
    file: string;
    line: number;
    functionName: string;
    data: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }>;
}

function formatProbeForContext(probe: ContextResponse['probes'][number]): string {
  const lines: string[] = [];
  lines.push(`[${probe.probeType.toUpperCase()}] ${probe.functionName || '(anonymous)'} in ${probe.file}:${probe.line}`);
  lines.push(`  Timestamp: ${probe.timestamp}`);

  const data = probe.data;
  switch (probe.probeType) {
    case 'error':
      if (data.errorType) lines.push(`  Error: ${data.errorType}: ${data.message}`);
      if (data.stack) {
        const stackLines = String(data.stack).split('\n').slice(0, 5);
        lines.push(`  Stack:\n    ${stackLines.join('\n    ')}`);
      }
      if (data.codeLine) lines.push(`  Code: ${data.codeLine}`);
      break;

    case 'database':
      if (data.operation) lines.push(`  Operation: ${data.operation}`);
      if (data.query) lines.push(`  Query: ${String(data.query).slice(0, 200)}`);
      if (data.duration !== undefined) lines.push(`  Duration: ${data.duration}ms`);
      if (data.rowCount !== undefined) lines.push(`  Rows: ${data.rowCount}`);
      break;

    case 'api':
      if (data.method && data.url) lines.push(`  ${data.method} ${data.url}`);
      if (data.statusCode !== undefined) lines.push(`  Status: ${data.statusCode}`);
      if (data.duration !== undefined) lines.push(`  Duration: ${data.duration}ms`);
      if (data.error) lines.push(`  Error: ${data.error}`);
      break;

    case 'infra':
      if (data.provider) lines.push(`  Provider: ${data.provider}`);
      if (data.region) lines.push(`  Region: ${data.region}`);
      if (data.serviceType) lines.push(`  Service: ${data.serviceType}`);
      if (data.memoryUsage !== undefined) lines.push(`  Memory: ${data.memoryUsage}MB`);
      break;

    case 'function':
      if (data.duration !== undefined) lines.push(`  Duration: ${data.duration}ms`);
      if (data.llmContext) lines.push(`  LLM Context: ${String(data.llmContext).slice(0, 300)}`);
      if (data.args) lines.push(`  Args: ${JSON.stringify(data.args).slice(0, 200)}`);
      break;

    default: {
      const dataStr = JSON.stringify(data);
      if (dataStr.length < 300) {
        lines.push(`  Data: ${dataStr}`);
      }
      break;
    }
  }

  return lines.join('\n');
}

async function fetchProductionContext(
  endpoint: string,
  prompt: string,
): Promise<string | null> {
  try {
    const url = new URL('/api/v1/probes/context', endpoint);
    url.searchParams.set('prompt', prompt);
    url.searchParams.set('limit', '10');

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as ContextResponse;

    if (data.count === 0) {
      return null;
    }

    const sections: string[] = [];

    // Group probes by type
    const byType: Record<string, ContextResponse['probes']> = {};
    for (const probe of data.probes) {
      if (!byType[probe.probeType]) byType[probe.probeType] = [];
      byType[probe.probeType].push(probe);
    }

    for (const [type, probes] of Object.entries(byType)) {
      sections.push(`--- ${type.toUpperCase()} PROBES (${probes.length}) ---`);
      for (const probe of probes) {
        sections.push(formatProbeForContext(probe));
      }
      sections.push('');
    }

    return sections.join('\n');
  } catch {
    return null;
  }
}

export const codexCommand = new Command('codex')
  .description('Run OpenAI Codex CLI with production context from Utopia')
  .argument('<prompt...>', 'The prompt to pass to Codex')
  .action(async (promptParts: string[]) => {
    const cwd = process.cwd();
    const prompt = promptParts.join(' ');

    if (!configExists(cwd)) {
      console.log(chalk.red('\n  Error: No .utopia/config.json found.'));
      console.log(chalk.dim('  Run "utopia init" first to set up your project.\n'));
      process.exit(1);
    }

    const config = await loadConfig(cwd);

    console.log(chalk.bold.cyan('\n  Fetching production context from Utopia...\n'));

    const context = await fetchProductionContext(
      config.dataEndpoint,
      prompt,
    );

    let enrichedPrompt: string;

    if (context) {
      console.log(chalk.green('  Production context retrieved successfully.'));
      console.log(chalk.dim('  Enriching prompt with production data...\n'));

      enrichedPrompt = [
        '[PRODUCTION CONTEXT from Utopia]',
        context,
        '[END PRODUCTION CONTEXT]',
        '',
        prompt,
      ].join('\n');
    } else {
      console.log(chalk.yellow('  No production context available (service may not be running).'));
      console.log(chalk.dim('  Passing prompt to Codex without enrichment.\n'));
      enrichedPrompt = prompt;
    }

    console.log(chalk.dim('  Launching Codex...\n'));

    const child = spawn('codex', [enrichedPrompt], {
      stdio: 'inherit',
      shell: true,
      cwd,
      env: {
        ...process.env,
        UTOPIA_PROJECT_ID: config.projectId,
        UTOPIA_ENDPOINT: config.dataEndpoint,
      },
    });

    child.on('close', (code) => {
      process.exit(code ?? 0);
    });

    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log(chalk.red('\n  Error: "codex" command not found.'));
        console.log(chalk.dim('  Install OpenAI Codex CLI: npm install -g @openai/codex\n'));
      } else {
        console.log(chalk.red(`\n  Error: Failed to launch Codex: ${err.message}\n`));
      }
      process.exit(1);
    });
  });
