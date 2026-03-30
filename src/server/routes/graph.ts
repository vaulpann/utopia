import { Router, Request, Response } from 'express';
import { getDb } from '../db/index.js';

const router: Router = Router();

interface NodeRow {
  id: string;
  type: string;
  name: string;
  file: string | null;
  metadata: string;
}

interface EdgeRow {
  source: string;
  target: string;
  type: string;
  weight: number;
  last_seen: string;
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

function rowToNode(row: NodeRow): NodeResponse {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    file: row.file,
    metadata: JSON.parse(row.metadata),
  };
}

function rowToEdge(row: EdgeRow): EdgeResponse {
  return {
    source: row.source,
    target: row.target,
    type: row.type,
    weight: row.weight,
    lastSeen: row.last_seen,
  };
}

const VALID_NODE_TYPES = new Set(['function', 'service', 'database', 'api', 'file']);
const VALID_EDGE_TYPES = new Set(['calls', 'queries', 'serves', 'depends_on']);

// POST /nodes - Upsert graph nodes (single or array)
router.post('/nodes', (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body;
  const nodes: Record<string, unknown>[] = Array.isArray(body) ? body : [body];

  if (nodes.length === 0) {
    res.status(400).json({ error: 'Request body must contain node data' });
    return;
  }

  const errors: Array<{ index: number; error: string }> = [];

  const upsertStmt = db.prepare(`
    INSERT INTO graph_nodes (id, type, name, file, metadata)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type,
      name = excluded.name,
      file = excluded.file,
      metadata = excluded.metadata
  `);

  const upsertMany = db.transaction((nodeList: Record<string, unknown>[]) => {
    let upserted = 0;
    for (let i = 0; i < nodeList.length; i++) {
      const node = nodeList[i];

      if (!node.id || typeof node.id !== 'string') {
        errors.push({ index: i, error: 'Missing or invalid "id"' });
        continue;
      }
      if (!node.type || !VALID_NODE_TYPES.has(node.type as string)) {
        errors.push({ index: i, error: `Invalid "type". Must be one of: ${[...VALID_NODE_TYPES].join(', ')}` });
        continue;
      }
      if (!node.name || typeof node.name !== 'string') {
        errors.push({ index: i, error: 'Missing or invalid "name"' });
        continue;
      }

      upsertStmt.run(
        node.id,
        node.type,
        node.name,
        (node.file as string) ?? null,
        JSON.stringify(node.metadata ?? {}),
      );
      upserted++;
    }
    return upserted;
  });

  const upserted = upsertMany(nodes);

  if (errors.length > 0 && upserted === 0) {
    res.status(400).json({ error: 'All nodes failed validation', details: errors });
    return;
  }

  res.status(201).json({
    upserted,
    errors: errors.length > 0 ? errors : undefined,
  });
});

// POST /edges - Upsert graph edges (increment weight on conflict)
router.post('/edges', (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body;
  const edges: Record<string, unknown>[] = Array.isArray(body) ? body : [body];

  if (edges.length === 0) {
    res.status(400).json({ error: 'Request body must contain edge data' });
    return;
  }

  const errors: Array<{ index: number; error: string }> = [];

  const upsertStmt = db.prepare(`
    INSERT INTO graph_edges (source, target, type, weight, last_seen)
    VALUES (?, ?, ?, 1, datetime('now'))
    ON CONFLICT(source, target, type) DO UPDATE SET
      weight = graph_edges.weight + 1,
      last_seen = datetime('now')
  `);

  const upsertMany = db.transaction((edgeList: Record<string, unknown>[]) => {
    let upserted = 0;
    for (let i = 0; i < edgeList.length; i++) {
      const edge = edgeList[i];

      if (!edge.source || typeof edge.source !== 'string') {
        errors.push({ index: i, error: 'Missing or invalid "source"' });
        continue;
      }
      if (!edge.target || typeof edge.target !== 'string') {
        errors.push({ index: i, error: 'Missing or invalid "target"' });
        continue;
      }
      if (!edge.type || !VALID_EDGE_TYPES.has(edge.type as string)) {
        errors.push({ index: i, error: `Invalid "type". Must be one of: ${[...VALID_EDGE_TYPES].join(', ')}` });
        continue;
      }

      // Verify that source and target nodes exist
      const sourceExists = db.prepare('SELECT id FROM graph_nodes WHERE id = ?').get(edge.source);
      const targetExists = db.prepare('SELECT id FROM graph_nodes WHERE id = ?').get(edge.target);

      if (!sourceExists) {
        errors.push({ index: i, error: `Source node "${edge.source}" does not exist` });
        continue;
      }
      if (!targetExists) {
        errors.push({ index: i, error: `Target node "${edge.target}" does not exist` });
        continue;
      }

      upsertStmt.run(edge.source, edge.target, edge.type);
      upserted++;
    }
    return upserted;
  });

  const upserted = upsertMany(edges);

  if (errors.length > 0 && upserted === 0) {
    res.status(400).json({ error: 'All edges failed validation', details: errors });
    return;
  }

  res.status(201).json({
    upserted,
    errors: errors.length > 0 ? errors : undefined,
  });
});

// GET / - Get full graph or filter by node type
router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const nodeType = req.query.type as string | undefined;

  let nodes: NodeRow[];
  let edges: EdgeRow[];

  if (nodeType) {
    if (!VALID_NODE_TYPES.has(nodeType)) {
      res.status(400).json({
        error: `Invalid node type "${nodeType}". Must be one of: ${[...VALID_NODE_TYPES].join(', ')}`,
      });
      return;
    }

    nodes = db.prepare('SELECT * FROM graph_nodes WHERE type = ?').all(nodeType) as NodeRow[];

    // Get edges where both source and target are in the filtered node set
    const nodeIds = nodes.map(n => n.id);
    if (nodeIds.length === 0) {
      res.json({ nodes: [], edges: [] });
      return;
    }

    const placeholders = nodeIds.map(() => '?').join(',');
    edges = db.prepare(
      `SELECT * FROM graph_edges WHERE source IN (${placeholders}) OR target IN (${placeholders})`
    ).all(...nodeIds, ...nodeIds) as EdgeRow[];
  } else {
    nodes = db.prepare('SELECT * FROM graph_nodes').all() as NodeRow[];
    edges = db.prepare('SELECT * FROM graph_edges').all() as EdgeRow[];
  }

  res.json({
    nodes: nodes.map(rowToNode),
    edges: edges.map(rowToEdge),
  });
});

// GET /impact/:nodeId - BFS traversal outward from node, depth limit 5
router.get('/impact/:nodeId', (req: Request, res: Response) => {
  const db = getDb();
  const startNodeId = req.params.nodeId as string;
  const maxDepth = Math.min(parseInt(req.query.depth as string, 10) || 5, 10);

  // Verify start node exists
  const startNode = db.prepare('SELECT * FROM graph_nodes WHERE id = ?').get(startNodeId) as NodeRow | undefined;
  if (!startNode) {
    res.status(404).json({ error: `Node "${startNodeId}" not found` });
    return;
  }

  const visitedNodes = new Set<string>([startNodeId]);
  const collectedEdges: EdgeRow[] = [];
  let frontier: string[] = [startNodeId];

  const edgeQuery = db.prepare(
    'SELECT * FROM graph_edges WHERE source = ?'
  );

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];

    for (const nodeId of frontier) {
      const edges = edgeQuery.all(nodeId) as EdgeRow[];
      for (const edge of edges) {
        collectedEdges.push(edge);
        if (!visitedNodes.has(edge.target)) {
          visitedNodes.add(edge.target);
          nextFrontier.push(edge.target);
        }
      }
    }

    frontier = nextFrontier;
  }

  // Fetch all visited node details
  const nodeIds = [...visitedNodes];
  const placeholders = nodeIds.map(() => '?').join(',');
  const nodes = db.prepare(
    `SELECT * FROM graph_nodes WHERE id IN (${placeholders})`
  ).all(...nodeIds) as NodeRow[];

  // Deduplicate edges by (source, target, type) key
  const edgeMap = new Map<string, EdgeRow>();
  for (const edge of collectedEdges) {
    const key = `${edge.source}|${edge.target}|${edge.type}`;
    edgeMap.set(key, edge);
  }

  res.json({
    startNode: startNodeId,
    depth: maxDepth,
    nodes: nodes.map(rowToNode),
    edges: [...edgeMap.values()].map(rowToEdge),
  });
});

// GET /dependencies/:nodeId - BFS traversal inward (reverse edges) to find dependencies, depth limit 5
router.get('/dependencies/:nodeId', (req: Request, res: Response) => {
  const db = getDb();
  const startNodeId = req.params.nodeId as string;
  const maxDepth = Math.min(parseInt(req.query.depth as string, 10) || 5, 10);

  // Verify start node exists
  const startNode = db.prepare('SELECT * FROM graph_nodes WHERE id = ?').get(startNodeId) as NodeRow | undefined;
  if (!startNode) {
    res.status(404).json({ error: `Node "${startNodeId}" not found` });
    return;
  }

  const visitedNodes = new Set<string>([startNodeId]);
  const collectedEdges: EdgeRow[] = [];
  let frontier: string[] = [startNodeId];

  const edgeQuery = db.prepare(
    'SELECT * FROM graph_edges WHERE target = ?'
  );

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];

    for (const nodeId of frontier) {
      const edges = edgeQuery.all(nodeId) as EdgeRow[];
      for (const edge of edges) {
        collectedEdges.push(edge);
        if (!visitedNodes.has(edge.source)) {
          visitedNodes.add(edge.source);
          nextFrontier.push(edge.source);
        }
      }
    }

    frontier = nextFrontier;
  }

  // Fetch all visited node details
  const nodeIds = [...visitedNodes];
  const placeholders = nodeIds.map(() => '?').join(',');
  const nodes = db.prepare(
    `SELECT * FROM graph_nodes WHERE id IN (${placeholders})`
  ).all(...nodeIds) as NodeRow[];

  // Deduplicate edges
  const edgeMap = new Map<string, EdgeRow>();
  for (const edge of collectedEdges) {
    const key = `${edge.source}|${edge.target}|${edge.type}`;
    edgeMap.set(key, edge);
  }

  res.json({
    startNode: startNodeId,
    depth: maxDepth,
    nodes: nodes.map(rowToNode),
    edges: [...edgeMap.values()].map(rowToEdge),
  });
});

export default router;
