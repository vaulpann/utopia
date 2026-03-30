import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ENDPOINT = process.env.UTOPIA_ENDPOINT ?? 'http://localhost:7890';
const PROJECT_ID = process.env.UTOPIA_PROJECT_ID; // optional global filter

// ---------------------------------------------------------------------------
// Shared types for API responses
// ---------------------------------------------------------------------------

interface ProbeResponse {
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

interface ProbeListResponse {
  count: number;
  probes: ProbeResponse[];
  keywords?: string[];
}

interface NodeResponse {
  id: string;
  type: string;
  name: string;
  file: string | null;
  metadata: Record<string, unknown>;
}

interface EdgeResponse {
  source: string;
  target: string;
  type: string;
  weight: number;
  lastSeen: string;
}

interface GraphResponse {
  nodes: NodeResponse[];
  edges: EdgeResponse[];
}

interface ImpactResponse {
  startNode: string;
  depth: number;
  nodes: NodeResponse[];
  edges: EdgeResponse[];
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function fetchFromUtopia(
  path: string,
  params?: Record<string, string>,
): Promise<unknown> {
  const url = new URL(path, ENDPOINT);

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, value);
      }
    }
  }

  if (PROJECT_ID) {
    url.searchParams.set('project_id', PROJECT_ID);
  }

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      return { error: `HTTP ${response.status}: ${body}` };
    }

    return await response.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to reach Utopia data service at ${ENDPOINT}: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function isErrorResponse(data: unknown): data is { error: string } {
  return (
    typeof data === 'object' &&
    data !== null &&
    'error' in data &&
    typeof (data as Record<string, unknown>).error === 'string'
  );
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  } catch {
    return ts;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}us`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

// ---------------------------------------------------------------------------
// Tool response formatters
// ---------------------------------------------------------------------------

function formatContextProbes(probes: ProbeResponse[], keywords: string[]): string {
  if (probes.length === 0) {
    return 'No production context found matching the query.';
  }

  const lines: string[] = [];
  lines.push(`Found ${probes.length} relevant probe(s) matching keywords: ${keywords.join(', ')}`);
  lines.push('');

  // Group by probe type
  const grouped = new Map<string, ProbeResponse[]>();
  for (const probe of probes) {
    const existing = grouped.get(probe.probeType) ?? [];
    existing.push(probe);
    grouped.set(probe.probeType, existing);
  }

  for (const [probeType, group] of grouped) {
    lines.push(`--- ${probeType.toUpperCase()} (${group.length}) ---`);
    lines.push('');

    for (const probe of group) {
      lines.push(`  File: ${probe.file}:${probe.line}`);
      if (probe.functionName) {
        lines.push(`  Function: ${probe.functionName}`);
      }
      lines.push(`  Time: ${formatTimestamp(probe.timestamp)}`);

      // Type-specific summary
      const d = probe.data;
      if (probeType === 'error') {
        lines.push(`  Error: ${d.errorType}: ${d.message}`);
        if (d.codeLine) lines.push(`  Code: ${d.codeLine}`);
      } else if (probeType === 'database') {
        if (d.query) lines.push(`  Query: ${truncate(String(d.query), 120)}`);
        if (d.table) lines.push(`  Table: ${d.table}`);
        if (d.duration !== undefined) lines.push(`  Duration: ${formatDuration(d.duration as number)}`);
      } else if (probeType === 'api') {
        lines.push(`  ${d.method} ${d.url} -> ${d.statusCode ?? 'pending'}`);
        if (d.duration !== undefined) lines.push(`  Latency: ${formatDuration(d.duration as number)}`);
      } else if (probeType === 'function') {
        if (d.duration !== undefined) lines.push(`  Duration: ${formatDuration(d.duration as number)}`);
        if (d.llmContext) lines.push(`  Context: ${d.llmContext}`);
      } else if (probeType === 'infra') {
        if (d.provider) lines.push(`  Provider: ${d.provider}`);
        if (d.region) lines.push(`  Region: ${d.region}`);
      }

      lines.push('');
    }
  }

  return lines.join('\n');
}

function formatErrors(probes: ProbeResponse[]): string {
  if (probes.length === 0) {
    return 'No recent errors found.';
  }

  const lines: string[] = [];
  lines.push(`Found ${probes.length} recent error(s):`);
  lines.push('');

  for (let i = 0; i < probes.length; i++) {
    const probe = probes[i];
    const d = probe.data;

    lines.push(`[${i + 1}] ${d.errorType ?? 'Error'}: ${d.message ?? 'Unknown error'}`);
    lines.push(`    File: ${probe.file}:${probe.line}`);
    if (probe.functionName) {
      lines.push(`    Function: ${probe.functionName}()`);
    }
    lines.push(`    Time: ${formatTimestamp(probe.timestamp)}`);

    if (d.codeLine) {
      lines.push(`    Code line: ${d.codeLine}`);
    }

    if (d.stack) {
      const stackLines = String(d.stack).split('\n').slice(0, 5);
      lines.push('    Stack trace:');
      for (const sl of stackLines) {
        lines.push(`      ${sl.trim()}`);
      }
      if (String(d.stack).split('\n').length > 5) {
        lines.push('      ...(truncated)');
      }
    }

    if (d.inputData && typeof d.inputData === 'object' && Object.keys(d.inputData as object).length > 0) {
      lines.push(`    Input data: ${truncate(JSON.stringify(d.inputData), 200)}`);
    }

    const env = probe.metadata.environment;
    if (env) {
      lines.push(`    Environment: ${env}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

function formatDatabaseContext(probes: ProbeResponse[]): string {
  if (probes.length === 0) {
    return 'No database interaction data found.';
  }

  const lines: string[] = [];
  lines.push(`Found ${probes.length} database interaction(s):`);
  lines.push('');

  // Compute aggregate stats
  const tableStats = new Map<string, { count: number; totalDuration: number }>();
  const queryPatterns = new Map<string, number>();

  for (const probe of probes) {
    const d = probe.data;
    const table = String(d.table ?? 'unknown');
    const duration = (d.duration as number) ?? 0;

    const existing = tableStats.get(table) ?? { count: 0, totalDuration: 0 };
    existing.count++;
    existing.totalDuration += duration;
    tableStats.set(table, existing);

    if (d.query) {
      // Normalize query to a pattern (strip literals)
      const pattern = String(d.query)
        .replace(/'[^']*'/g, '?')
        .replace(/\b\d+\b/g, '?')
        .trim();
      queryPatterns.set(pattern, (queryPatterns.get(pattern) ?? 0) + 1);
    }
  }

  // Table summary
  if (tableStats.size > 0) {
    lines.push('--- Table Summary ---');
    for (const [table, stats] of tableStats) {
      const avgMs = stats.totalDuration / stats.count;
      lines.push(`  ${table}: ${stats.count} operation(s), avg ${formatDuration(avgMs)}`);
    }
    lines.push('');
  }

  // Query patterns
  if (queryPatterns.size > 0) {
    lines.push('--- Query Patterns ---');
    const sorted = [...queryPatterns.entries()].sort((a, b) => b[1] - a[1]);
    for (const [pattern, count] of sorted.slice(0, 15)) {
      lines.push(`  [${count}x] ${truncate(pattern, 120)}`);
    }
    lines.push('');
  }

  // Individual interactions
  lines.push('--- Details ---');
  for (const probe of probes) {
    const d = probe.data;
    lines.push(`  File: ${probe.file}:${probe.line}`);
    if (probe.functionName) lines.push(`  Function: ${probe.functionName}()`);
    lines.push(`  Operation: ${d.operation ?? 'unknown'}`);
    if (d.query) lines.push(`  Query: ${truncate(String(d.query), 150)}`);
    if (d.table) lines.push(`  Table: ${d.table}`);
    if (d.duration !== undefined) lines.push(`  Duration: ${formatDuration(d.duration as number)}`);
    if (d.rowCount !== undefined) lines.push(`  Rows: ${d.rowCount}`);

    const conn = d.connectionInfo as Record<string, unknown> | undefined;
    if (conn) {
      const parts: string[] = [];
      if (conn.type) parts.push(String(conn.type));
      if (conn.host) parts.push(String(conn.host));
      if (conn.database) parts.push(String(conn.database));
      if (parts.length > 0) lines.push(`  Connection: ${parts.join(' / ')}`);
    }

    lines.push(`  Time: ${formatTimestamp(probe.timestamp)}`);
    lines.push('');
  }

  return lines.join('\n');
}

function formatApiContext(probes: ProbeResponse[]): string {
  if (probes.length === 0) {
    return 'No external API call data found.';
  }

  const lines: string[] = [];
  lines.push(`Found ${probes.length} API call(s):`);
  lines.push('');

  // Aggregate by endpoint pattern
  const endpointStats = new Map<
    string,
    { count: number; totalDuration: number; statuses: Map<number, number> }
  >();

  for (const probe of probes) {
    const d = probe.data;
    const key = `${d.method ?? 'GET'} ${d.url ?? 'unknown'}`;
    const existing = endpointStats.get(key) ?? {
      count: 0,
      totalDuration: 0,
      statuses: new Map<number, number>(),
    };
    existing.count++;
    existing.totalDuration += (d.duration as number) ?? 0;
    if (d.statusCode !== undefined) {
      const sc = d.statusCode as number;
      existing.statuses.set(sc, (existing.statuses.get(sc) ?? 0) + 1);
    }
    endpointStats.set(key, existing);
  }

  // Endpoint summary
  lines.push('--- Endpoint Summary ---');
  const sorted = [...endpointStats.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [endpoint, stats] of sorted) {
    const avgMs = stats.totalDuration / stats.count;
    const statusStr = [...stats.statuses.entries()]
      .map(([code, cnt]) => `${code}:${cnt}`)
      .join(', ');
    lines.push(`  ${endpoint}`);
    lines.push(`    Calls: ${stats.count}, Avg latency: ${formatDuration(avgMs)}`);
    if (statusStr) lines.push(`    Status codes: ${statusStr}`);
  }
  lines.push('');

  // Individual calls
  lines.push('--- Details ---');
  for (const probe of probes) {
    const d = probe.data;
    lines.push(`  File: ${probe.file}:${probe.line}`);
    if (probe.functionName) lines.push(`  Function: ${probe.functionName}()`);
    lines.push(`  ${d.method ?? 'GET'} ${d.url ?? 'unknown'} -> ${d.statusCode ?? 'pending'}`);
    if (d.duration !== undefined) lines.push(`  Latency: ${formatDuration(d.duration as number)}`);
    if (d.error) lines.push(`  Error: ${d.error}`);
    lines.push(`  Time: ${formatTimestamp(probe.timestamp)}`);
    lines.push('');
  }

  return lines.join('\n');
}

function formatInfraContext(probes: ProbeResponse[]): string {
  if (probes.length === 0) {
    return 'No infrastructure data found.';
  }

  const lines: string[] = [];
  lines.push(`Infrastructure context (${probes.length} probe(s)):`);
  lines.push('');

  for (const probe of probes) {
    const d = probe.data;

    lines.push(`--- ${probe.file}:${probe.line} ---`);
    if (probe.functionName) lines.push(`  Function: ${probe.functionName}()`);
    if (d.provider) lines.push(`  Cloud provider: ${d.provider}`);
    if (d.region) lines.push(`  Region: ${d.region}`);
    if (d.serviceType) lines.push(`  Service type: ${d.serviceType}`);
    if (d.instanceId) lines.push(`  Instance ID: ${d.instanceId}`);

    const container = d.containerInfo as Record<string, unknown> | undefined;
    if (container) {
      if (container.containerId) lines.push(`  Container ID: ${container.containerId}`);
      if (container.image) lines.push(`  Container image: ${container.image}`);
    }

    if (d.memoryUsage !== undefined) {
      const mb = (d.memoryUsage as number) / (1024 * 1024);
      lines.push(`  Memory usage: ${mb.toFixed(1)} MB`);
    }
    if (d.cpuUsage !== undefined) {
      lines.push(`  CPU usage: ${((d.cpuUsage as number) * 100).toFixed(1)}%`);
    }

    const envVars = d.envVars as Record<string, string> | undefined;
    if (envVars && Object.keys(envVars).length > 0) {
      lines.push('  Environment variables:');
      for (const [k, v] of Object.entries(envVars)) {
        // Mask sensitive values
        const masked = /key|secret|token|password|credential/i.test(k)
          ? '***'
          : String(v);
        lines.push(`    ${k}=${masked}`);
      }
    }

    const env = probe.metadata.environment;
    if (env) lines.push(`  Environment: ${env}`);
    const hostname = probe.metadata.hostname;
    if (hostname) lines.push(`  Hostname: ${hostname}`);

    lines.push(`  Captured: ${formatTimestamp(probe.timestamp)}`);
    lines.push('');
  }

  return lines.join('\n');
}

function formatImpactAnalysis(
  startNodeId: string,
  impact: ImpactResponse,
): string {
  const lines: string[] = [];

  const startNode = impact.nodes.find(n => n.id === startNodeId);
  const startLabel = startNode
    ? `${startNode.type}:${startNode.name}${startNode.file ? ` (${startNode.file})` : ''}`
    : startNodeId;

  lines.push(`Impact analysis for: ${startLabel}`);
  lines.push('');

  // Separate direct vs transitive
  const directEdges = impact.edges.filter(e => e.source === startNodeId);
  const directTargetIds = new Set(directEdges.map(e => e.target));
  const transitiveNodes = impact.nodes.filter(
    n => n.id !== startNodeId && !directTargetIds.has(n.id),
  );

  // Direct dependencies
  if (directEdges.length > 0) {
    lines.push(`--- Direct Dependencies (${directEdges.length}) ---`);
    for (const edge of directEdges) {
      const targetNode = impact.nodes.find(n => n.id === edge.target);
      const label = targetNode
        ? `${targetNode.type}:${targetNode.name}${targetNode.file ? ` (${targetNode.file})` : ''}`
        : edge.target;
      lines.push(`  -> [${edge.type}] ${label} (weight: ${edge.weight})`);
    }
    lines.push('');
  } else {
    lines.push('No direct dependencies found.');
    lines.push('');
  }

  // Transitive dependencies
  if (transitiveNodes.length > 0) {
    lines.push(`--- Transitive Dependencies (${transitiveNodes.length}) ---`);
    for (const node of transitiveNodes) {
      const label = `${node.type}:${node.name}${node.file ? ` (${node.file})` : ''}`;
      lines.push(`  - ${label}`);
    }
    lines.push('');
  }

  // Affected services
  const services = impact.nodes.filter(
    n => n.type === 'service' && n.id !== startNodeId,
  );
  if (services.length > 0) {
    lines.push(`--- Affected Services (${services.length}) ---`);
    for (const svc of services) {
      lines.push(`  * ${svc.name}${svc.file ? ` (${svc.file})` : ''}`);
    }
    lines.push('');
  }

  // Affected databases
  const databases = impact.nodes.filter(
    n => n.type === 'database' && n.id !== startNodeId,
  );
  if (databases.length > 0) {
    lines.push(`--- Affected Databases (${databases.length}) ---`);
    for (const db of databases) {
      lines.push(`  * ${db.name}`);
    }
    lines.push('');
  }

  // Summary
  lines.push('--- Summary ---');
  lines.push(`  Total nodes in impact graph: ${impact.nodes.length}`);
  lines.push(`  Total edges: ${impact.edges.length}`);
  lines.push(`  Direct dependencies: ${directEdges.length}`);
  lines.push(`  Transitive dependencies: ${transitiveNodes.length}`);
  lines.push(`  Affected services: ${services.length}`);
  lines.push(`  Affected databases: ${databases.length}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'utopia',
  version: '0.1.0',
});

// ---- Tool 1: get_production_context ----

server.tool(
  'get_production_context',
  'Get production context relevant to a coding task. Analyzes probe data from production to provide real-time context about how code runs, including errors, database patterns, API calls, and infrastructure details.',
  {
    prompt: z.string().describe('The coding task or question to find relevant production context for'),
    file: z.string().optional().describe('Specific file path to focus on'),
    limit: z.number().optional().default(20).describe('Maximum number of results to return'),
  },
  async ({ prompt, file, limit }) => {
    const params: Record<string, string> = {
      prompt: encodeURIComponent(prompt),
      limit: String(limit ?? 20),
    };
    if (file) params.file = file;

    const data = await fetchFromUtopia('/api/v1/probes/context', params);

    if (isErrorResponse(data)) {
      return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] };
    }

    const response = data as ProbeListResponse;
    const text = formatContextProbes(response.probes ?? [], response.keywords ?? []);

    return { content: [{ type: 'text' as const, text }] };
  },
);

// ---- Tool 2: get_recent_errors ----

server.tool(
  'get_recent_errors',
  'Get recent production errors with full context including stack traces, input data that caused the error, and the exact code line where it broke.',
  {
    hours: z.number().optional().default(24).describe('Lookback window in hours'),
    file: z.string().optional().describe('Filter errors by file path'),
    limit: z.number().optional().default(20).describe('Maximum number of errors to return'),
  },
  async ({ hours, file, limit }) => {
    const params: Record<string, string> = {
      hours: String(hours ?? 24),
      limit: String(limit ?? 20),
    };
    if (file) params.file = file;

    const data = await fetchFromUtopia('/api/v1/probes/errors/recent', params);

    if (isErrorResponse(data)) {
      return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] };
    }

    const response = data as ProbeListResponse;
    let probes = response.probes ?? [];

    // Client-side file filter since the server endpoint doesn't support it natively
    if (file) {
      probes = probes.filter(p => p.file === file || p.file.includes(file));
    }

    const text = formatErrors(probes);

    return { content: [{ type: 'text' as const, text }] };
  },
);

// ---- Tool 3: get_database_context ----

server.tool(
  'get_database_context',
  'Get database interaction patterns from production. Shows queries, tables accessed, response times, connection details, and data patterns for database operations in the codebase.',
  {
    file: z.string().optional().describe('Filter by file path'),
    function_name: z.string().optional().describe('Filter by function name'),
    limit: z.number().optional().default(20).describe('Maximum number of results'),
  },
  async ({ file, function_name, limit }) => {
    const params: Record<string, string> = {
      probe_type: 'database',
      limit: String(limit ?? 20),
    };
    if (file) params.file = file;
    if (function_name) params.function_name = function_name;

    const data = await fetchFromUtopia('/api/v1/probes', params);

    if (isErrorResponse(data)) {
      return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] };
    }

    const response = data as ProbeListResponse;
    const text = formatDatabaseContext(response.probes ?? []);

    return { content: [{ type: 'text' as const, text }] };
  },
);

// ---- Tool 4: get_api_context ----

server.tool(
  'get_api_context',
  'Get external API call patterns from production. Shows endpoints called, HTTP methods, response codes, latencies, and request/response patterns.',
  {
    file: z.string().optional().describe('Filter by file path'),
    url_pattern: z.string().optional().describe('Filter by URL pattern (substring match)'),
    limit: z.number().optional().default(20).describe('Maximum number of results'),
  },
  async ({ file, url_pattern, limit }) => {
    const params: Record<string, string> = {
      probe_type: 'api',
      limit: String(limit ?? 20),
    };
    if (file) params.file = file;

    const data = await fetchFromUtopia('/api/v1/probes', params);

    if (isErrorResponse(data)) {
      return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] };
    }

    const response = data as ProbeListResponse;
    let probes = response.probes ?? [];

    // Client-side URL pattern filter
    if (url_pattern) {
      const pattern = url_pattern.toLowerCase();
      probes = probes.filter(p => {
        const url = String(p.data.url ?? '').toLowerCase();
        return url.includes(pattern);
      });
    }

    const text = formatApiContext(probes);

    return { content: [{ type: 'text' as const, text }] };
  },
);

// ---- Tool 5: get_infrastructure_context ----

server.tool(
  'get_infrastructure_context',
  'Get infrastructure and deployment context. Shows where code is deployed, cloud provider, region, service type, environment variables, and resource usage.',
  {},
  async () => {
    const params: Record<string, string> = {
      probe_type: 'infra',
      limit: '10',
    };

    const data = await fetchFromUtopia('/api/v1/probes', params);

    if (isErrorResponse(data)) {
      return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] };
    }

    const response = data as ProbeListResponse;
    const text = formatInfraContext(response.probes ?? []);

    return { content: [{ type: 'text' as const, text }] };
  },
);

// ---- Tool 6: get_impact_analysis ----

server.tool(
  'get_impact_analysis',
  'Analyze the impact of changing a specific function, file, or service. Shows all dependent code, services, and infrastructure that would be affected.',
  {
    node_id: z.string().optional().describe('Direct node ID in the impact graph'),
    file: z.string().optional().describe('File path to find in the graph'),
    function_name: z.string().optional().describe('Function name to find in the graph'),
  },
  async ({ node_id, file, function_name }) => {
    let nodeId = node_id;

    // If no direct node_id, look up the node by file and/or function_name
    if (!nodeId) {
      if (!file && !function_name) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Error: Provide at least one of node_id, file, or function_name.',
          }],
        };
      }

      const graphData = await fetchFromUtopia('/api/v1/graph');

      if (isErrorResponse(graphData)) {
        return { content: [{ type: 'text' as const, text: `Error: ${graphData.error}` }] };
      }

      const graph = graphData as GraphResponse;
      const matchingNode = graph.nodes.find(n => {
        if (file && function_name) {
          return n.file === file && n.name === function_name;
        }
        if (file) {
          return n.file === file;
        }
        return n.name === function_name;
      });

      if (!matchingNode) {
        // Try a more relaxed match (substring)
        const relaxedMatch = graph.nodes.find(n => {
          const fileMatch = file
            ? (n.file ?? '').includes(file) || file.includes(n.file ?? '\0')
            : true;
          const fnMatch = function_name
            ? n.name === function_name || n.name.includes(function_name)
            : true;
          return fileMatch && fnMatch;
        });

        if (!relaxedMatch) {
          const hint = file && function_name
            ? `file="${file}", function="${function_name}"`
            : file
              ? `file="${file}"`
              : `function="${function_name}"`;
          return {
            content: [{
              type: 'text' as const,
              text: `No graph node found matching ${hint}. The impact graph may not have data for this code yet. Ensure probes are running in production.`,
            }],
          };
        }

        nodeId = relaxedMatch.id;
      } else {
        nodeId = matchingNode.id;
      }
    }

    const impactData = await fetchFromUtopia(`/api/v1/graph/impact/${encodeURIComponent(nodeId)}`);

    if (isErrorResponse(impactData)) {
      return { content: [{ type: 'text' as const, text: `Error: ${impactData.error}` }] };
    }

    const impact = impactData as ImpactResponse;
    const text = formatImpactAnalysis(nodeId, impact);

    return { content: [{ type: 'text' as const, text }] };
  },
);

// ---- Tool 7: get_full_context ----

server.tool(
  'get_full_context',
  'Get comprehensive production context for the entire project. Combines recent errors, database patterns, API patterns, and infrastructure into a complete picture. Use this when starting work on a new task.',
  {
    limit: z.number().optional().default(10).describe('Maximum results per category'),
  },
  async ({ limit }) => {
    const perCategory = String(limit ?? 10);

    // Fire all requests in parallel
    const [errorsData, dbData, apiData, infraData] = await Promise.all([
      fetchFromUtopia('/api/v1/probes/errors/recent', {
        hours: '24',
        limit: perCategory,
      }),
      fetchFromUtopia('/api/v1/probes', {
        probe_type: 'database',
        limit: perCategory,
      }),
      fetchFromUtopia('/api/v1/probes', {
        probe_type: 'api',
        limit: perCategory,
      }),
      fetchFromUtopia('/api/v1/probes', {
        probe_type: 'infra',
        limit: perCategory,
      }),
    ]);

    const sections: string[] = [];

    sections.push('=== FULL PRODUCTION CONTEXT ===');
    sections.push('');

    // Errors section
    sections.push('============================');
    sections.push('  RECENT ERRORS (last 24h)');
    sections.push('============================');
    if (isErrorResponse(errorsData)) {
      sections.push(`Error fetching errors: ${errorsData.error}`);
    } else {
      const resp = errorsData as ProbeListResponse;
      sections.push(formatErrors(resp.probes ?? []));
    }
    sections.push('');

    // Database section
    sections.push('============================');
    sections.push('  DATABASE PATTERNS');
    sections.push('============================');
    if (isErrorResponse(dbData)) {
      sections.push(`Error fetching database context: ${dbData.error}`);
    } else {
      const resp = dbData as ProbeListResponse;
      sections.push(formatDatabaseContext(resp.probes ?? []));
    }
    sections.push('');

    // API section
    sections.push('============================');
    sections.push('  API CALL PATTERNS');
    sections.push('============================');
    if (isErrorResponse(apiData)) {
      sections.push(`Error fetching API context: ${apiData.error}`);
    } else {
      const resp = apiData as ProbeListResponse;
      sections.push(formatApiContext(resp.probes ?? []));
    }
    sections.push('');

    // Infrastructure section
    sections.push('============================');
    sections.push('  INFRASTRUCTURE');
    sections.push('============================');
    if (isErrorResponse(infraData)) {
      sections.push(`Error fetching infrastructure context: ${infraData.error}`);
    } else {
      const resp = infraData as ProbeListResponse;
      sections.push(formatInfraContext(resp.probes ?? []));
    }

    const text = sections.join('\n');

    return { content: [{ type: 'text' as const, text }] };
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
