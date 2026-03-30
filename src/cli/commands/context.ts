import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig, configExists } from '../utils/config.js';

interface ProbeResult {
  id: string;
  projectId: string;
  probeType: string;
  timestamp: string;
  file: string;
  line: number;
  functionName: string;
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

interface ContextResponse {
  count: number;
  keywords?: string[];
  probes: ProbeResult[];
}

function formatProbe(probe: ProbeResult): string {
  const lines: string[] = [];
  const typeColor = getTypeColor(probe.probeType);

  lines.push(`  ${typeColor(probe.probeType.toUpperCase())} ${chalk.white(probe.functionName || '(anonymous)')} ${chalk.dim(`in ${probe.file}:${probe.line}`)}`);
  lines.push(chalk.dim(`    ${probe.timestamp}`));

  // Format data based on probe type
  const data = probe.data;
  switch (probe.probeType) {
    case 'error':
      if (data.errorType) lines.push(chalk.red(`    ${data.errorType}: ${data.message}`));
      if (data.stack) {
        const stackLines = String(data.stack).split('\n').slice(0, 3);
        for (const sl of stackLines) {
          lines.push(chalk.dim(`    ${sl.trim()}`));
        }
      }
      break;

    case 'database':
      if (data.operation) lines.push(`    Operation: ${chalk.cyan(String(data.operation))}`);
      if (data.query) lines.push(chalk.dim(`    Query: ${String(data.query).slice(0, 120)}`));
      if (data.duration !== undefined) lines.push(chalk.dim(`    Duration: ${data.duration}ms`));
      break;

    case 'api':
      if (data.method && data.url) {
        lines.push(`    ${chalk.cyan(String(data.method))} ${String(data.url)}`);
      }
      if (data.statusCode !== undefined) {
        const statusNum = Number(data.statusCode);
        const statusStr = String(data.statusCode);
        const statusColor = statusNum >= 400 ? chalk.red : statusNum >= 300 ? chalk.yellow : chalk.green;
        lines.push(`    Status: ${statusColor(statusStr)}`);
      }
      if (data.duration !== undefined) lines.push(chalk.dim(`    Duration: ${data.duration}ms`));
      break;

    case 'infra':
      if (data.provider) lines.push(`    Provider: ${chalk.cyan(String(data.provider))}`);
      if (data.region) lines.push(`    Region: ${chalk.cyan(String(data.region))}`);
      if (data.memoryUsage !== undefined) lines.push(chalk.dim(`    Memory: ${data.memoryUsage}MB`));
      break;

    case 'function':
      if (data.duration !== undefined) lines.push(chalk.dim(`    Duration: ${data.duration}ms`));
      if (data.llmContext) lines.push(chalk.magenta(`    Context: ${String(data.llmContext).slice(0, 200)}`));
      break;

    default: {
      const dataStr = JSON.stringify(data, null, 2);
      if (dataStr.length < 200) {
        lines.push(chalk.dim(`    ${dataStr}`));
      }
      break;
    }
  }

  return lines.join('\n');
}

function getTypeColor(type: string): (s: string) => string {
  switch (type) {
    case 'error': return chalk.bgRed.white;
    case 'database': return chalk.bgBlue.white;
    case 'api': return chalk.bgGreen.white;
    case 'infra': return chalk.bgYellow.black;
    case 'function': return chalk.bgMagenta.white;
    default: return chalk.bgGray.white;
  }
}

export const contextCommand = new Command('context')
  .description('Query production context from the Utopia data service')
  .argument('<prompt>', 'The context query')
  .option('--file <file>', 'Focus on a specific file')
  .option('--type <type>', 'Filter by probe type (error, database, api, infra, function)')
  .option('--limit <n>', 'Maximum number of results', '20')
  .action(async (prompt: string, options) => {
    const cwd = process.cwd();

    if (!configExists(cwd)) {
      console.log(chalk.red('\n  Error: No .utopia/config.json found.'));
      console.log(chalk.dim('  Run "utopia init" first to set up your project.\n'));
      process.exit(1);
    }

    const config = await loadConfig(cwd);
    const endpoint = config.dataEndpoint;

    console.log(chalk.bold.cyan('\n  Querying production context...\n'));
    console.log(chalk.dim(`  Query: "${prompt}"`));

    // Build query URL
    const url = new URL('/api/v1/probes/context', endpoint);
    url.searchParams.set('prompt', prompt);
    url.searchParams.set('limit', options.limit as string);

    if (options.file) {
      // If filtering by file, also do a direct probes query
      url.searchParams.set('file', options.file as string);
    }

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.log(chalk.red(`\n  Error: Data service returned ${response.status}`));
        console.log(chalk.dim(`  ${errorBody}\n`));
        process.exit(1);
      }

      const data = (await response.json()) as ContextResponse;

      if (data.keywords && data.keywords.length > 0) {
        console.log(chalk.dim(`  Keywords: ${data.keywords.join(', ')}`));
      }
      console.log(chalk.dim(`  Results: ${data.count}\n`));

      if (data.count === 0) {
        console.log(chalk.yellow('  No matching probes found.'));
        console.log(chalk.dim('  Try a broader query or check that probes are being collected.\n'));
        return;
      }

      // Filter by type if specified
      let probes = data.probes;
      if (options.type) {
        probes = probes.filter((p) => p.probeType === options.type);
        if (probes.length === 0) {
          console.log(chalk.yellow(`  No probes of type "${options.type}" found in results.\n`));
          return;
        }
      }

      // Filter by file if specified (server may not support file param in context endpoint)
      if (options.file) {
        const fileFilter = options.file as string;
        probes = probes.filter((p) => p.file.includes(fileFilter));
      }

      for (const probe of probes) {
        console.log(formatProbe(probe));
        console.log('');
      }

      console.log(chalk.dim(`  Showing ${probes.length} of ${data.count} results.\n`));
    } catch (err) {
      const errorMessage = (err as Error).message;
      if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('fetch failed')) {
        console.log(chalk.red('\n  Error: Could not connect to the Utopia data service.'));
        console.log(chalk.dim(`  Endpoint: ${endpoint}`));
        console.log(chalk.dim('  Make sure the service is running: utopia serve\n'));
      } else {
        console.log(chalk.red(`\n  Error: ${errorMessage}\n`));
      }
      process.exit(1);
    }
  });
