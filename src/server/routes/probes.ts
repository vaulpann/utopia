import { Router, Request, Response } from 'express';
import { getDb } from '../db/index.js';

const router: Router = Router();

interface ProbeRow {
  id: string;
  project_id: string;
  probe_type: string;
  timestamp: string;
  file: string;
  line: number;
  function_name: string;
  data: string;
  metadata: string;
}

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

function rowToProbe(row: ProbeRow): ProbeResponse {
  return {
    id: row.id,
    projectId: row.project_id,
    probeType: row.probe_type,
    timestamp: row.timestamp,
    file: row.file,
    line: row.line,
    functionName: row.function_name,
    data: JSON.parse(row.data),
    metadata: JSON.parse(row.metadata),
  };
}

const VALID_PROBE_TYPES = new Set(['error', 'database', 'api', 'infra', 'function']);

function validateProbe(probe: Record<string, unknown>): string | null {
  if (!probe.id || typeof probe.id !== 'string') return 'Missing or invalid "id"';
  if (!probe.project_id && !probe.projectId) return 'Missing "project_id"';
  if (!probe.probe_type && !probe.probeType) return 'Missing "probe_type"';
  const probeType = (probe.probe_type || probe.probeType) as string;
  if (!VALID_PROBE_TYPES.has(probeType)) {
    return `Invalid probe_type "${probeType}". Must be one of: error, database, api, infra, function`;
  }
  if (!probe.file || typeof probe.file !== 'string') return 'Missing or invalid "file"';
  if (probe.line === undefined || probe.line === null || typeof probe.line !== 'number') {
    return 'Missing or invalid "line"';
  }
  return null;
}

// POST / - Ingest probe data (single or array)
router.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body;

  const probes: Record<string, unknown>[] = Array.isArray(body) ? body : [body];

  if (probes.length === 0) {
    res.status(400).json({ error: 'Request body must contain probe data' });
    return;
  }

  const errors: Array<{ index: number; error: string }> = [];

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO probes (id, project_id, probe_type, timestamp, file, line, function_name, data, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((probeList: Record<string, unknown>[]) => {
    let inserted = 0;
    for (let i = 0; i < probeList.length; i++) {
      const probe = probeList[i];
      const validationError = validateProbe(probe);
      if (validationError) {
        errors.push({ index: i, error: validationError });
        continue;
      }

      const projectId = (probe.project_id || probe.projectId) as string;
      const probeType = (probe.probe_type || probe.probeType) as string;
      const timestamp = (probe.timestamp as string) || new Date().toISOString();
      const functionName = (probe.function_name || probe.functionName || '') as string;

      insertStmt.run(
        probe.id,
        projectId,
        probeType,
        timestamp,
        probe.file,
        probe.line,
        functionName,
        JSON.stringify(probe.data ?? {}),
        JSON.stringify(probe.metadata ?? {}),
      );
      inserted++;
    }
    return inserted;
  });

  const inserted = insertMany(probes);

  if (errors.length > 0 && inserted === 0) {
    res.status(400).json({ error: 'All probes failed validation', details: errors });
    return;
  }

  res.status(201).json({
    inserted,
    errors: errors.length > 0 ? errors : undefined,
  });
});

// GET /errors/recent - Get recent errors
// Must be defined BEFORE /:id to avoid matching "errors" as an id
router.get('/errors/recent', (req: Request, res: Response) => {
  const db = getDb();
  const hours = parseInt(req.query.hours as string, 10) || 24;
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 1000);

  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const rows = db.prepare(`
    SELECT * FROM probes
    WHERE probe_type = 'error' AND timestamp >= ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(since, limit) as ProbeRow[];

  res.json({
    count: rows.length,
    probes: rows.map(rowToProbe),
  });
});

// GET /context - Smart context retrieval
// Must be defined BEFORE /:id to avoid matching "context" as an id
router.get('/context', (req: Request, res: Response) => {
  const db = getDb();
  const prompt = req.query.prompt as string;

  if (!prompt) {
    res.status(400).json({ error: 'Missing "prompt" query parameter' });
    return;
  }

  const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);

  // Extract keywords: split on whitespace/non-alphanumeric, filter stopwords and short tokens
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'is', 'it', 'this', 'that', 'are', 'was', 'were',
    'be', 'been', 'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'can', 'not', 'no', 'what', 'how',
    'why', 'when', 'where', 'which', 'who', 'whom', 'from', 'into', 'than',
    'then', 'there', 'here', 'just', 'also', 'very', 'too', 'some', 'any',
    'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'about',
  ]);

  const keywords = prompt
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter(w => w.length >= 2 && !stopWords.has(w));

  if (keywords.length === 0) {
    res.json({ count: 0, probes: [], keywords: [] });
    return;
  }

  // Build WHERE clause: match any keyword against file, function_name, or data
  const conditions = keywords.map(() =>
    '(LOWER(file) LIKE ? OR LOWER(function_name) LIKE ? OR LOWER(data) LIKE ?)'
  );

  const whereParams: string[] = [];
  for (const kw of keywords) {
    const pattern = `%${kw}%`;
    whereParams.push(pattern, pattern, pattern);
  }

  // Build relevance scoring: count how many keyword/column matches
  const relevanceExpr = keywords.map(() =>
    '(CASE WHEN LOWER(file) LIKE ? THEN 1 ELSE 0 END + ' +
    'CASE WHEN LOWER(function_name) LIKE ? THEN 1 ELSE 0 END + ' +
    'CASE WHEN LOWER(data) LIKE ? THEN 1 ELSE 0 END)'
  ).join(' + ');

  const relevanceParams: string[] = [];
  for (const kw of keywords) {
    const pattern = `%${kw}%`;
    relevanceParams.push(pattern, pattern, pattern);
  }

  const sql = `
    SELECT *, (${relevanceExpr}) as relevance
    FROM probes
    WHERE ${conditions.join(' OR ')}
    ORDER BY relevance DESC, timestamp DESC
    LIMIT ?
  `;

  const allParams = [...relevanceParams, ...whereParams, limit];
  const rows = db.prepare(sql).all(...allParams) as (ProbeRow & { relevance: number })[];

  res.json({
    count: rows.length,
    keywords,
    probes: rows.map(rowToProbe),
  });
});

// GET /:id - Get single probe by ID
router.get('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM probes WHERE id = ?').get(req.params.id) as ProbeRow | undefined;

  if (!row) {
    res.status(404).json({ error: 'Probe not found' });
    return;
  }

  res.json(rowToProbe(row));
});

// GET / - Query probes with filters
router.get('/', (req: Request, res: Response) => {
  const db = getDb();

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (req.query.probe_type) {
    conditions.push('probe_type = ?');
    params.push(req.query.probe_type as string);
  }

  if (req.query.file) {
    conditions.push('file = ?');
    params.push(req.query.file as string);
  }

  if (req.query.function_name) {
    conditions.push('function_name = ?');
    params.push(req.query.function_name as string);
  }

  if (req.query.project_id) {
    conditions.push('project_id = ?');
    params.push(req.query.project_id as string);
  }

  if (req.query.since) {
    conditions.push('timestamp >= ?');
    params.push(req.query.since as string);
  }

  if (req.query.until) {
    conditions.push('timestamp <= ?');
    params.push(req.query.until as string);
  }

  const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 1000);

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT * FROM probes ${whereClause} ORDER BY timestamp DESC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as ProbeRow[];

  res.json({
    count: rows.length,
    probes: rows.map(rowToProbe),
  });
});

export default router;
