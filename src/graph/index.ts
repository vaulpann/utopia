import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProbeRecord {
  id: string;
  project_id: string;
  probe_type: string;
  timestamp: string;
  file: string;
  line: number;
  function_name: string;
  data: string; // JSON string
  metadata: string; // JSON string
}

interface GraphNodeRecord {
  id: string;
  type: string;
  name: string;
  file: string | null;
  metadata: string; // JSON string
}

interface GraphEdgeRecord {
  source: string;
  target: string;
  type: string;
  weight: number;
  last_seen: string;
}

interface ImpactResult {
  rootNode: GraphNodeRecord;
  impactedNodes: { node: GraphNodeRecord; depth: number; path: string[] }[];
  edges: GraphEdgeRecord[];
  totalImpacted: number;
}

interface DependencyResult {
  rootNode: GraphNodeRecord;
  dependencies: { node: GraphNodeRecord; depth: number; path: string[] }[];
  edges: GraphEdgeRecord[];
  totalDependencies: number;
}

interface GraphStats {
  totalNodes: number;
  nodesByType: Record<string, number>;
  totalEdges: number;
  edgesByType: Record<string, number>;
  mostConnected: { node: GraphNodeRecord; connectionCount: number }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a deterministic node ID from type and name.
 * Format: `type:name`
 */
function nodeId(type: string, name: string): string {
  return `${type}:${name}`;
}

/**
 * Derive a stable API node name from a URL string.
 * Strips query parameters, fragments, trailing slashes, and normalises the
 * result to `hostname/path`.
 */
function normalizeApiName(raw: string): string {
  try {
    const url = new URL(raw);
    // hostname + pathname, strip trailing slash
    const pathname = url.pathname.replace(/\/+$/, '') || '';
    return `${url.hostname}${pathname}`;
  } catch {
    // If URL parsing fails, do a best-effort strip of query/fragment
    const cleaned = raw.split('?')[0].split('#')[0].replace(/\/+$/, '');
    return cleaned;
  }
}

// ---------------------------------------------------------------------------
// ImpactGraph
// ---------------------------------------------------------------------------

class ImpactGraph {
  private db: Database.Database;

  // Prepared statements — lazily initialised on first use so that the
  // constructor never throws if the schema hasn't been created yet.
  private stmts!: {
    upsertNode: Database.Statement;
    upsertEdge: Database.Statement;
    getNode: Database.Statement;
    getOutEdges: Database.Statement;
    getInEdges: Database.Statement;
    allNodes: Database.Statement;
    allEdges: Database.Statement;
    allProbes: Database.Statement;
    nodesByType: Database.Statement;
    edgesForNodeSet: (ids: string[]) => Database.Statement;
    countNodes: Database.Statement;
    countEdges: Database.Statement;
    nodeCountsByType: Database.Statement;
    edgeCountsByType: Database.Statement;
  };

  private prepared = false;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // ------------------------------------------------------------------
  // Statement preparation
  // ------------------------------------------------------------------

  private ensurePrepared(): void {
    if (this.prepared) return;

    const db = this.db;

    this.stmts = {
      upsertNode: db.prepare(`
        INSERT INTO graph_nodes (id, type, name, file, metadata)
        VALUES (@id, @type, @name, @file, @metadata)
        ON CONFLICT(id) DO UPDATE SET
          type = excluded.type,
          name = excluded.name,
          file = excluded.file,
          metadata = excluded.metadata
      `),

      upsertEdge: db.prepare(`
        INSERT INTO graph_edges (source, target, type, weight, last_seen)
        VALUES (@source, @target, @type, 1, datetime('now'))
        ON CONFLICT(source, target, type) DO UPDATE SET
          weight = graph_edges.weight + 1,
          last_seen = datetime('now')
      `),

      getNode: db.prepare('SELECT * FROM graph_nodes WHERE id = ?'),

      getOutEdges: db.prepare('SELECT * FROM graph_edges WHERE source = ?'),

      getInEdges: db.prepare('SELECT * FROM graph_edges WHERE target = ?'),

      allNodes: db.prepare('SELECT * FROM graph_nodes'),

      allEdges: db.prepare('SELECT * FROM graph_edges'),

      allProbes: db.prepare('SELECT * FROM probes ORDER BY timestamp ASC'),

      nodesByType: db.prepare('SELECT * FROM graph_nodes WHERE type = ?'),

      // Dynamic — returns a fresh statement for a given set of IDs
      edgesForNodeSet: (ids: string[]) => {
        const ph = ids.map(() => '?').join(',');
        return db.prepare(
          `SELECT * FROM graph_edges WHERE source IN (${ph}) OR target IN (${ph})`,
        );
      },

      countNodes: db.prepare('SELECT COUNT(*) as cnt FROM graph_nodes'),

      countEdges: db.prepare('SELECT COUNT(*) as cnt FROM graph_edges'),

      nodeCountsByType: db.prepare(
        'SELECT type, COUNT(*) as cnt FROM graph_nodes GROUP BY type',
      ),

      edgeCountsByType: db.prepare(
        'SELECT type, COUNT(*) as cnt FROM graph_edges GROUP BY type',
      ),
    };

    this.prepared = true;
  }

  // ------------------------------------------------------------------
  // Low-level graph mutations
  // ------------------------------------------------------------------

  private upsertNode(
    type: string,
    name: string,
    file: string | null,
    metadata: Record<string, unknown> = {},
  ): GraphNodeRecord {
    this.ensurePrepared();
    const id = nodeId(type, name);
    this.stmts.upsertNode.run({
      id,
      type,
      name,
      file,
      metadata: JSON.stringify(metadata),
    });
    return { id, type, name, file, metadata: JSON.stringify(metadata) };
  }

  private upsertEdge(source: string, target: string, type: string): void {
    this.ensurePrepared();
    this.stmts.upsertEdge.run({ source, target, type });
  }

  // ------------------------------------------------------------------
  // processProbe
  // ------------------------------------------------------------------

  processProbe(probe: ProbeRecord): void {
    this.ensurePrepared();

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(probe.data);
    } catch {
      data = {};
    }

    const file = probe.file;
    const functionName = probe.function_name;

    switch (probe.probe_type) {
      case 'error':
        this.processErrorProbe(file, functionName, data);
        break;
      case 'database':
        this.processDatabaseProbe(file, functionName, data);
        break;
      case 'api':
        this.processApiProbe(file, functionName, data);
        break;
      case 'infra':
        this.processInfraProbe(file, data);
        break;
      case 'function':
        this.processFunctionProbe(file, functionName, data);
        break;
      default:
        // Unknown probe type — silently ignore
        break;
    }
  }

  private processErrorProbe(
    file: string,
    functionName: string,
    data: Record<string, unknown>,
  ): void {
    // Function node for the function that errored
    const fnName = functionName || 'unknown';
    const fnNodeName = `${file}:${fnName}`;
    this.upsertNode('function', fnNodeName, file, {
      errorType: data.errorType,
      message: data.message,
    });

    // File node
    this.upsertNode('file', file, file);

    // Edge: function -> file
    this.upsertEdge(nodeId('function', fnNodeName), nodeId('file', file), 'depends_on');
  }

  private processDatabaseProbe(
    file: string,
    functionName: string,
    data: Record<string, unknown>,
  ): void {
    // Function node for the caller
    const fnName = functionName || 'unknown';
    const fnNodeName = `${file}:${fnName}`;
    this.upsertNode('function', fnNodeName, file);

    // Database node — prefer table name, fall back to connection info
    let dbName: string;
    if (data.table && typeof data.table === 'string') {
      dbName = data.table;
    } else if (
      data.connectionInfo &&
      typeof data.connectionInfo === 'object' &&
      (data.connectionInfo as Record<string, unknown>).database
    ) {
      dbName = String((data.connectionInfo as Record<string, unknown>).database);
    } else {
      dbName = 'unknown';
    }

    const connInfo = data.connectionInfo as Record<string, unknown> | undefined;
    this.upsertNode('database', dbName, null, {
      operation: data.operation,
      connectionType: connInfo?.type,
      host: connInfo?.host,
    });

    // Edge: function -> database (queries)
    this.upsertEdge(nodeId('function', fnNodeName), nodeId('database', dbName), 'queries');
  }

  private processApiProbe(
    file: string,
    functionName: string,
    data: Record<string, unknown>,
  ): void {
    // Function node for the caller
    const fnName = functionName || 'unknown';
    const fnNodeName = `${file}:${fnName}`;
    this.upsertNode('function', fnNodeName, file);

    // API node — derive name from URL
    const rawUrl = (data.url as string) || 'unknown';
    const apiName = normalizeApiName(rawUrl);
    this.upsertNode('api', apiName, null, {
      method: data.method,
      statusCode: data.statusCode,
    });

    // Edge: function -> api (calls)
    this.upsertEdge(nodeId('function', fnNodeName), nodeId('api', apiName), 'calls');
  }

  private processInfraProbe(
    file: string,
    data: Record<string, unknown>,
  ): void {
    // Service node — derive service name from provider + serviceType or fallback
    const provider = (data.provider as string) || 'unknown';
    const serviceType = (data.serviceType as string) || 'service';
    const serviceName = `${provider}:${serviceType}`;

    this.upsertNode('service', serviceName, null, {
      provider,
      region: data.region,
      instanceId: data.instanceId,
    });

    // File node for the file the probe was placed in
    this.upsertNode('file', file, file);

    // Edge: service -> file (serves)
    this.upsertEdge(nodeId('service', serviceName), nodeId('file', file), 'serves');
  }

  private processFunctionProbe(
    file: string,
    functionName: string,
    data: Record<string, unknown>,
  ): void {
    // The probed function itself
    const fnName = functionName || 'unknown';
    const fnNodeName = `${file}:${fnName}`;
    this.upsertNode('function', fnNodeName, file, {
      duration: data.duration,
    });

    // Process call stack: each entry is a caller of the next
    const callStack = (data.callStack as string[]) || [];
    if (callStack.length > 0) {
      // The call stack typically goes from outermost to innermost.
      // Create nodes for each stack frame and edges between consecutive
      // callers. We also connect the deepest caller to our function.
      let previousNodeId: string | null = null;
      for (const frame of callStack) {
        // Frame format is usually "file:function" or just a function name
        const frameName = frame.includes(':') ? frame : `${file}:${frame}`;
        const frameFile = frame.includes(':') ? frame.split(':').slice(0, -1).join(':') : file;

        this.upsertNode('function', frameName, frameFile);

        if (previousNodeId !== null) {
          this.upsertEdge(previousNodeId, nodeId('function', frameName), 'calls');
        }

        previousNodeId = nodeId('function', frameName);
      }

      // Connect deepest caller to the probed function
      if (previousNodeId !== null && previousNodeId !== nodeId('function', fnNodeName)) {
        this.upsertEdge(previousNodeId, nodeId('function', fnNodeName), 'calls');
      }
    }
  }

  // ------------------------------------------------------------------
  // getImpact — BFS outward (following outgoing edges)
  // ------------------------------------------------------------------

  getImpact(startNodeId: string, maxDepth: number = 5): ImpactResult {
    this.ensurePrepared();

    const rootNode = this.stmts.getNode.get(startNodeId) as GraphNodeRecord | undefined;
    if (!rootNode) {
      throw new Error(`Node "${startNodeId}" not found`);
    }

    const visited = new Set<string>([startNodeId]);
    const collectedEdges: GraphEdgeRecord[] = [];
    const impactedNodes: { node: GraphNodeRecord; depth: number; path: string[] }[] = [];

    // Map node ID -> shortest path from root
    const pathMap = new Map<string, string[]>();
    pathMap.set(startNodeId, [startNodeId]);

    let frontier = [startNodeId];

    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];

      for (const currentId of frontier) {
        const edges = this.stmts.getOutEdges.all(currentId) as GraphEdgeRecord[];
        for (const edge of edges) {
          collectedEdges.push(edge);
          if (!visited.has(edge.target)) {
            visited.add(edge.target);
            nextFrontier.push(edge.target);

            const parentPath = pathMap.get(currentId) || [currentId];
            pathMap.set(edge.target, [...parentPath, edge.target]);

            const targetNode = this.stmts.getNode.get(edge.target) as
              | GraphNodeRecord
              | undefined;
            if (targetNode) {
              impactedNodes.push({
                node: targetNode,
                depth,
                path: pathMap.get(edge.target)!,
              });
            }
          }
        }
      }

      frontier = nextFrontier;
    }

    // Deduplicate edges
    const edgeMap = new Map<string, GraphEdgeRecord>();
    for (const edge of collectedEdges) {
      const key = `${edge.source}|${edge.target}|${edge.type}`;
      edgeMap.set(key, edge);
    }

    return {
      rootNode,
      impactedNodes,
      edges: [...edgeMap.values()],
      totalImpacted: impactedNodes.length,
    };
  }

  // ------------------------------------------------------------------
  // getDependencies — BFS inward (following incoming edges in reverse)
  // ------------------------------------------------------------------

  getDependencies(startNodeId: string, maxDepth: number = 5): DependencyResult {
    this.ensurePrepared();

    const rootNode = this.stmts.getNode.get(startNodeId) as GraphNodeRecord | undefined;
    if (!rootNode) {
      throw new Error(`Node "${startNodeId}" not found`);
    }

    const visited = new Set<string>([startNodeId]);
    const collectedEdges: GraphEdgeRecord[] = [];
    const dependencies: { node: GraphNodeRecord; depth: number; path: string[] }[] = [];

    const pathMap = new Map<string, string[]>();
    pathMap.set(startNodeId, [startNodeId]);

    let frontier = [startNodeId];

    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];

      for (const currentId of frontier) {
        const edges = this.stmts.getInEdges.all(currentId) as GraphEdgeRecord[];
        for (const edge of edges) {
          collectedEdges.push(edge);
          if (!visited.has(edge.source)) {
            visited.add(edge.source);
            nextFrontier.push(edge.source);

            const parentPath = pathMap.get(currentId) || [currentId];
            pathMap.set(edge.source, [...parentPath, edge.source]);

            const sourceNode = this.stmts.getNode.get(edge.source) as
              | GraphNodeRecord
              | undefined;
            if (sourceNode) {
              dependencies.push({
                node: sourceNode,
                depth,
                path: pathMap.get(edge.source)!,
              });
            }
          }
        }
      }

      frontier = nextFrontier;
    }

    // Deduplicate edges
    const edgeMap = new Map<string, GraphEdgeRecord>();
    for (const edge of collectedEdges) {
      const key = `${edge.source}|${edge.target}|${edge.type}`;
      edgeMap.set(key, edge);
    }

    return {
      rootNode,
      dependencies,
      edges: [...edgeMap.values()],
      totalDependencies: dependencies.length,
    };
  }

  // ------------------------------------------------------------------
  // findNode — search nodes by partial match
  // ------------------------------------------------------------------

  findNode(query: {
    file?: string;
    functionName?: string;
    name?: string;
    type?: string;
  }): GraphNodeRecord[] {
    this.ensurePrepared();

    const conditions: string[] = [];
    const params: string[] = [];

    if (query.file) {
      conditions.push('file LIKE ?');
      params.push(`%${query.file}%`);
    }

    if (query.functionName) {
      conditions.push('name LIKE ?');
      params.push(`%${query.functionName}%`);
    }

    if (query.name) {
      conditions.push('name LIKE ?');
      params.push(`%${query.name}%`);
    }

    if (query.type) {
      conditions.push('type = ?');
      params.push(query.type);
    }

    if (conditions.length === 0) {
      return this.stmts.allNodes.all() as GraphNodeRecord[];
    }

    const sql = `SELECT * FROM graph_nodes WHERE ${conditions.join(' AND ')}`;
    return this.db.prepare(sql).all(...params) as GraphNodeRecord[];
  }

  // ------------------------------------------------------------------
  // getFullGraph
  // ------------------------------------------------------------------

  getFullGraph(nodeType?: string): { nodes: GraphNodeRecord[]; edges: GraphEdgeRecord[] } {
    this.ensurePrepared();

    if (!nodeType) {
      return {
        nodes: this.stmts.allNodes.all() as GraphNodeRecord[],
        edges: this.stmts.allEdges.all() as GraphEdgeRecord[],
      };
    }

    const nodes = this.stmts.nodesByType.all(nodeType) as GraphNodeRecord[];
    if (nodes.length === 0) {
      return { nodes: [], edges: [] };
    }

    const ids = nodes.map((n) => n.id);
    const edges = this.stmts.edgesForNodeSet(ids).all(...ids, ...ids) as GraphEdgeRecord[];

    return { nodes, edges };
  }

  // ------------------------------------------------------------------
  // buildFromProbes — full rebuild from the probes table
  // ------------------------------------------------------------------

  buildFromProbes(): void {
    this.ensurePrepared();

    // Clear existing graph data before rebuilding
    this.db.exec('DELETE FROM graph_edges');
    this.db.exec('DELETE FROM graph_nodes');

    const probes = this.stmts.allProbes.all() as ProbeRecord[];

    const processAll = this.db.transaction((probeList: ProbeRecord[]) => {
      for (const probe of probeList) {
        this.processProbe(probe);
      }
    });

    processAll(probes);
  }

  // ------------------------------------------------------------------
  // getStats
  // ------------------------------------------------------------------

  getStats(): GraphStats {
    this.ensurePrepared();

    const totalNodes = (this.stmts.countNodes.get() as { cnt: number }).cnt;
    const totalEdges = (this.stmts.countEdges.get() as { cnt: number }).cnt;

    const nodesByType: Record<string, number> = {};
    const nodeTypeRows = this.stmts.nodeCountsByType.all() as { type: string; cnt: number }[];
    for (const row of nodeTypeRows) {
      nodesByType[row.type] = row.cnt;
    }

    const edgesByType: Record<string, number> = {};
    const edgeTypeRows = this.stmts.edgeCountsByType.all() as { type: string; cnt: number }[];
    for (const row of edgeTypeRows) {
      edgesByType[row.type] = row.cnt;
    }

    // Most connected nodes: count outgoing + incoming edges per node, top 10
    const mostConnectedRows = this.db
      .prepare(
        `
        SELECT n.*, (
          (SELECT COUNT(*) FROM graph_edges WHERE source = n.id) +
          (SELECT COUNT(*) FROM graph_edges WHERE target = n.id)
        ) as connection_count
        FROM graph_nodes n
        ORDER BY connection_count DESC
        LIMIT 10
      `,
      )
      .all() as (GraphNodeRecord & { connection_count: number })[];

    const mostConnected = mostConnectedRows.map((row) => ({
      node: {
        id: row.id,
        type: row.type,
        name: row.name,
        file: row.file,
        metadata: row.metadata,
      } as GraphNodeRecord,
      connectionCount: row.connection_count,
    }));

    return {
      totalNodes,
      nodesByType,
      totalEdges,
      edgesByType,
      mostConnected,
    };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { ImpactGraph };
export default ImpactGraph;

export type {
  ProbeRecord,
  GraphNodeRecord,
  GraphEdgeRecord,
  ImpactResult,
  DependencyResult,
  GraphStats,
};
