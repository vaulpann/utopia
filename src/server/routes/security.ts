import { Router, Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { randomUUID } from 'node:crypto';

const router = Router();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Finding {
  id: string;
  rule_id: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  file: string | null;
  function_name: string | null;
  probe_ids: string[];
  status: string;
  created_at: string;
  updated_at: string;
}

interface ProbeRow {
  id: string;
  probe_type: string;
  file: string;
  function_name: string;
  data: string;
  metadata: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Detection rules
// ---------------------------------------------------------------------------

interface DetectionRule {
  id: string;
  name: string;
  severity: Finding['severity'];
  detect: (probes: ProbeRow[]) => Array<{
    title: string;
    description: string;
    evidence: Record<string, unknown>;
    file: string | null;
    function_name: string | null;
    probe_ids: string[];
  }>;
}

const SENSITIVE_FIELD_PATTERNS = /password|passwd|secret|api_key|apikey|ssn|social_security|credit_card|card_number|cvv|private_key|auth_token|session_id|access_token|refresh_token/i;

// Fields that match SENSITIVE_FIELD_PATTERNS but are not actually sensitive
// (e.g. LLM "token" in token_count, token_chunks, etc.)
const SAFE_FIELD_PATTERNS = /token_count|token_chunks|token_probability|token_length|token_usage|tokens_used|tokenize|tokenizer|tokenization|token_type|max_tokens|num_tokens|total_tokens|completion_tokens|prompt_tokens/i;

const DETECTION_RULES: DetectionRule[] = [
  // --- CRITICAL ---
  {
    id: 'sql-injection',
    name: 'Unparameterized SQL Query',
    severity: 'critical',
    detect: (probes) => {
      const findings: ReturnType<DetectionRule['detect']> = [];
      const dbProbes = probes.filter(p => p.probe_type === 'database');
      for (const probe of dbProbes) {
        const data = JSON.parse(probe.data);
        const query = String(data.query || '');
        // Look for string concatenation patterns in queries
        if (query && (
          data.parameterized === false ||
          data.raw_input_in_query === true ||
          /['"]?\s*\+\s*[a-zA-Z_]/.test(query) ||
          /f['"]/.test(query) ||
          /\$\{/.test(query)
        )) {
          findings.push({
            title: `Unparameterized SQL in ${probe.function_name || probe.file}`,
            description: `Database query appears to use string interpolation instead of parameterized inputs. This is a SQL injection vector.`,
            evidence: {
              query: query.substring(0, 500),
              parameterized: data.parameterized,
              raw_input: data.raw_input_in_query,
              operation: data.operation,
              table: data.table,
            },
            file: probe.file,
            function_name: probe.function_name,
            probe_ids: [probe.id],
          });
        }
      }
      return findings;
    },
  },

  // --- HIGH ---
  {
    id: 'sensitive-data-exposure',
    name: 'Sensitive Data in API Response',
    severity: 'high',
    detect: (probes) => {
      const findings: ReturnType<DetectionRule['detect']> = [];
      const apiProbes = probes.filter(p => p.probe_type === 'api' || p.probe_type === 'function');
      for (const probe of apiProbes) {
        const dataStr = probe.data;
        // Check if response/return data contains sensitive field names
        // Skip if all matches are safe compound words (e.g. token_count, token_chunks)
        const matches = dataStr.match(SENSITIVE_FIELD_PATTERNS);
        if (matches && !SAFE_FIELD_PATTERNS.test(dataStr.substring(Math.max(0, dataStr.indexOf(matches[0]) - 20), dataStr.indexOf(matches[0]) + matches[0].length + 30))) {
          const data = JSON.parse(probe.data);
          const returnVal = data.return_value || data.returnValue || data.response_body || data.responseBody;
          if (returnVal) {
            const returnStr = JSON.stringify(returnVal);
            const returnMatches = returnStr.match(SENSITIVE_FIELD_PATTERNS);
            // Check the matched context isn't a safe compound word
            if (returnMatches && !SAFE_FIELD_PATTERNS.test(returnStr)) {
              findings.push({
                title: `Sensitive field "${returnMatches[0]}" exposed in ${probe.function_name || probe.file}`,
                description: `The return value or API response includes a field matching "${returnMatches[0]}". This data may be exposed to clients.`,
                evidence: {
                  matched_field: returnMatches[0],
                  function: probe.function_name,
                  return_value_keys: typeof returnVal === 'object' ? Object.keys(returnVal).slice(0, 20) : typeof returnVal,
                },
                file: probe.file,
                function_name: probe.function_name,
                probe_ids: [probe.id],
              });
            }
          }
        }
      }
      // Deduplicate by file + function + matched field
      const seen = new Set<string>();
      return findings.filter(f => {
        const key = `${f.file}:${f.function_name}:${f.title}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
  },

  {
    id: 'error-detail-exposure',
    name: 'Internal Error Details Exposed',
    severity: 'high',
    detect: (probes) => {
      const findings: ReturnType<DetectionRule['detect']> = [];
      const errorProbes = probes.filter(p => p.probe_type === 'error');
      for (const probe of errorProbes) {
        const data = JSON.parse(probe.data);
        const stack = String(data.stack || data.traceback || '');
        const message = String(data.message || '');
        // Check if error details include internal paths or stack traces that might be exposed
        if ((stack.includes('/node_modules/') || stack.includes('site-packages/') || stack.includes('at Object.')) &&
            (data.exposed_to_client === true || data.in_response === true)) {
          findings.push({
            title: `Stack trace exposed to client in ${probe.function_name || probe.file}`,
            description: `Internal error details including file paths and stack frames are being returned to the client. This reveals internal architecture.`,
            evidence: {
              error_type: data.error_type || data.errorType,
              message_preview: message.substring(0, 200),
              stack_preview: stack.substring(0, 300),
            },
            file: probe.file,
            function_name: probe.function_name,
            probe_ids: [probe.id],
          });
        }
      }
      return findings;
    },
  },

  {
    id: 'missing-auth',
    name: 'Endpoint Without Auth Check',
    severity: 'high',
    detect: (probes) => {
      const findings: ReturnType<DetectionRule['detect']> = [];
      const apiProbes = probes.filter(p => p.probe_type === 'api' || p.probe_type === 'function');
      for (const probe of apiProbes) {
        const data = JSON.parse(probe.data);
        if (data.auth_checked === false || data.no_auth === true || data.auth_present === false) {
          findings.push({
            title: `No auth check on ${probe.function_name || probe.file}`,
            description: `This endpoint or function was accessed without authentication. If it handles sensitive data, this is a vulnerability.`,
            evidence: {
              auth_checked: data.auth_checked,
              auth_present: data.auth_present,
              method: data.method,
              url: data.url,
            },
            file: probe.file,
            function_name: probe.function_name,
            probe_ids: [probe.id],
          });
        }
      }
      const seen = new Set<string>();
      return findings.filter(f => {
        const key = `${f.file}:${f.function_name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
  },

  // --- MEDIUM ---
  {
    id: 'insecure-http',
    name: 'HTTP (Not HTTPS) External Call',
    severity: 'medium',
    detect: (probes) => {
      const findings: ReturnType<DetectionRule['detect']> = [];
      const apiProbes = probes.filter(p => p.probe_type === 'api');
      for (const probe of apiProbes) {
        const data = JSON.parse(probe.data);
        const url = String(data.url || '');
        if (url.startsWith('http://') && !url.includes('localhost') && !url.includes('127.0.0.1')) {
          findings.push({
            title: `HTTP call to ${new URL(url).hostname} from ${probe.function_name || probe.file}`,
            description: `External API call uses HTTP instead of HTTPS. Data is transmitted in plaintext.`,
            evidence: { url, method: data.method, function: probe.function_name },
            file: probe.file,
            function_name: probe.function_name,
            probe_ids: [probe.id],
          });
        }
      }
      const seen = new Set<string>();
      return findings.filter(f => {
        const key = `${f.file}:${(f.evidence as Record<string, unknown>).url}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
  },

  {
    id: 'cors-wildcard',
    name: 'CORS Allows All Origins',
    severity: 'medium',
    detect: (probes) => {
      const findings: ReturnType<DetectionRule['detect']> = [];
      const infraProbes = probes.filter(p => p.probe_type === 'infra' || p.probe_type === 'function');
      for (const probe of infraProbes) {
        const dataStr = probe.data;
        if (dataStr.includes('"*"') && (dataStr.includes('cors') || dataStr.includes('CORS') || dataStr.includes('Access-Control'))) {
          findings.push({
            title: `CORS wildcard (*) detected in ${probe.function_name || probe.file}`,
            description: `CORS is configured to allow all origins. Any website can make requests to this endpoint.`,
            evidence: { file: probe.file, function: probe.function_name },
            file: probe.file,
            function_name: probe.function_name,
            probe_ids: [probe.id],
          });
        }
      }
      return findings;
    },
  },

  {
    id: 'debug-mode-production',
    name: 'Debug Mode in Production',
    severity: 'medium',
    detect: (probes) => {
      const findings: ReturnType<DetectionRule['detect']> = [];
      const infraProbes = probes.filter(p => p.probe_type === 'infra');
      for (const probe of infraProbes) {
        const data = JSON.parse(probe.data);
        const envVars = data.env_vars || data.envVars || {};
        const meta = JSON.parse(probe.metadata || '{}');
        const env = meta.env || envVars.NODE_ENV || envVars.FLASK_ENV || envVars.DJANGO_DEBUG || '';
        if (
          envVars.DEBUG === 'true' || envVars.DEBUG === '1' ||
          envVars.FLASK_DEBUG === '1' || envVars.DJANGO_DEBUG === 'True' ||
          (String(env).includes('production') && (envVars.DEBUG === 'true' || envVars.DEBUG === '1'))
        ) {
          findings.push({
            title: 'Debug mode enabled in production',
            description: 'Application is running in debug mode while in a production environment. This exposes detailed error pages and internal state.',
            evidence: { env, debug_vars: { DEBUG: envVars.DEBUG, FLASK_DEBUG: envVars.FLASK_DEBUG, DJANGO_DEBUG: envVars.DJANGO_DEBUG } },
            file: probe.file,
            function_name: probe.function_name,
            probe_ids: [probe.id],
          });
        }
      }
      return findings;
    },
  },

  {
    id: 'unvalidated-input',
    name: 'Unvalidated User Input',
    severity: 'medium',
    detect: (probes) => {
      const findings: ReturnType<DetectionRule['detect']> = [];
      const allProbes = probes.filter(p => p.probe_type === 'function' || p.probe_type === 'api');
      for (const probe of allProbes) {
        const data = JSON.parse(probe.data);
        if (data.sanitized === false || data.validated === false || data.unsanitized_input === true) {
          findings.push({
            title: `Unvalidated input in ${probe.function_name || probe.file}`,
            description: `User-supplied input is used without validation or sanitization. This can lead to injection attacks.`,
            evidence: {
              sanitized: data.sanitized,
              validated: data.validated,
              input_source: data.input_source,
            },
            file: probe.file,
            function_name: probe.function_name,
            probe_ids: [probe.id],
          });
        }
      }
      const seen = new Set<string>();
      return findings.filter(f => {
        const key = `${f.file}:${f.function_name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
  },

  // --- LOW ---
  {
    id: 'expired-token-accepted',
    name: 'Expired Auth Token Accepted',
    severity: 'low',
    detect: (probes) => {
      const findings: ReturnType<DetectionRule['detect']> = [];
      const authProbes = probes.filter(p => {
        const dataStr = p.data;
        return dataStr.includes('token') || dataStr.includes('auth') || dataStr.includes('expired');
      });
      for (const probe of authProbes) {
        const data = JSON.parse(probe.data);
        if (data.token_valid === true && data.expired === true) {
          findings.push({
            title: `Expired token accepted in ${probe.function_name || probe.file}`,
            description: `An expired auth token was accepted as valid. Token expiration is not being enforced.`,
            evidence: { token_valid: data.token_valid, expired: data.expired },
            file: probe.file,
            function_name: probe.function_name,
            probe_ids: [probe.id],
          });
        }
      }
      return findings;
    },
  },
];

// ---------------------------------------------------------------------------
// Run all detection rules against probe data
// ---------------------------------------------------------------------------

function runDetections(hoursBack: number = 168): Finding[] {
  const db = getDb();
  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

  const probes = db.prepare(
    'SELECT id, probe_type, file, function_name, data, metadata, timestamp FROM probes WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT 5000'
  ).all(since) as ProbeRow[];

  if (probes.length === 0) return [];

  const allFindings: Finding[] = [];

  for (const rule of DETECTION_RULES) {
    try {
      const detections = rule.detect(probes);
      for (const det of detections) {
        // Check if this finding already exists (same rule + file + function)
        const existing = db.prepare(
          "SELECT id FROM security_findings WHERE rule_id = ? AND file = ? AND function_name = ? AND status != 'fixed'"
        ).get(rule.id, det.file || '', det.function_name || '') as { id: string } | undefined;

        if (existing) {
          // Update timestamp
          db.prepare('UPDATE security_findings SET updated_at = datetime("now") WHERE id = ?').run(existing.id);
          const row = db.prepare('SELECT * FROM security_findings WHERE id = ?').get(existing.id) as Record<string, string>;
          allFindings.push({
            ...row,
            evidence: JSON.parse(row.evidence),
            probe_ids: JSON.parse(row.probe_ids),
          } as unknown as Finding);
        } else {
          const id = randomUUID();
          db.prepare(`
            INSERT INTO security_findings (id, rule_id, severity, title, description, evidence, file, function_name, probe_ids)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            id, rule.id, rule.severity, det.title, det.description,
            JSON.stringify(det.evidence), det.file || '', det.function_name || '',
            JSON.stringify(det.probe_ids),
          );
          allFindings.push({
            id, rule_id: rule.id, severity: rule.severity,
            title: det.title, description: det.description,
            evidence: det.evidence, file: det.file || null,
            function_name: det.function_name || null,
            probe_ids: det.probe_ids, status: 'open',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
      }
    } catch { /* never let a rule crash the engine */ }
  }

  return allFindings;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Run detection rules and return findings
router.post('/scan', (_req: Request, res: Response) => {
  try {
    const hours = parseInt(String(_req.query.hours || '168'), 10);
    const findings = runDetections(hours);

    const bySeverity = {
      critical: findings.filter(f => f.severity === 'critical').length,
      high: findings.filter(f => f.severity === 'high').length,
      medium: findings.filter(f => f.severity === 'medium').length,
      low: findings.filter(f => f.severity === 'low').length,
      info: findings.filter(f => f.severity === 'info').length,
    };

    res.json({ count: findings.length, severity_summary: bySeverity, findings });
  } catch (err) {
    res.status(500).json({ error: `Scan failed: ${(err as Error).message}` });
  }
});

// Get all findings (with optional filters)
router.get('/findings', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const status = String(_req.query.status || 'open');
    const severity = _req.query.severity ? String(_req.query.severity) : undefined;
    const limit = Math.min(parseInt(String(_req.query.limit || '100'), 10), 1000);

    let sql = 'SELECT * FROM security_findings WHERE 1=1';
    const params: string[] = [];

    if (status !== 'all') {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (severity) {
      sql += ' AND severity = ?';
      params.push(severity);
    }

    sql += ' ORDER BY CASE severity WHEN \'critical\' THEN 0 WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 WHEN \'low\' THEN 3 ELSE 4 END, updated_at DESC';
    sql += ` LIMIT ${limit}`;

    const rows = db.prepare(sql).all(...params) as Array<Record<string, string>>;
    const findings = rows.map(row => ({
      ...row,
      evidence: JSON.parse(row.evidence || '{}'),
      probe_ids: JSON.parse(row.probe_ids || '[]'),
    }));

    res.json({ count: findings.length, findings });
  } catch (err) {
    res.status(500).json({ error: `Query failed: ${(err as Error).message}` });
  }
});

// Update finding status
router.patch('/findings/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { status } = req.body;

    if (!['open', 'acknowledged', 'fixed', 'false_positive'].includes(status)) {
      res.status(400).json({ error: 'Invalid status. Must be: open, acknowledged, fixed, false_positive' });
      return;
    }

    db.prepare('UPDATE security_findings SET status = ?, updated_at = datetime("now") WHERE id = ?').run(status, id);
    res.json({ updated: true, id, status });
  } catch (err) {
    res.status(500).json({ error: `Update failed: ${(err as Error).message}` });
  }
});

// Insert a finding (used by utopia audit to store AI-generated findings)
router.post('/findings', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { rule_id, severity, title, description, file, function_name, evidence } = req.body;

    if (!title || !severity) {
      res.status(400).json({ error: 'title and severity are required' });
      return;
    }

    if (!['critical', 'high', 'medium', 'low', 'info'].includes(severity)) {
      res.status(400).json({ error: 'Invalid severity' });
      return;
    }

    // Deduplicate by title
    const existing = db.prepare(
      "SELECT id FROM security_findings WHERE title = ? AND status != 'fixed'"
    ).get(title) as { id: string } | undefined;

    if (existing) {
      db.prepare('UPDATE security_findings SET updated_at = datetime("now") WHERE id = ?').run(existing.id);
      res.json({ inserted: false, id: existing.id, reason: 'already exists' });
      return;
    }

    const id = randomUUID();
    db.prepare(`
      INSERT INTO security_findings (id, rule_id, severity, title, description, evidence, file, function_name, probe_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]')
    `).run(
      id,
      rule_id || 'ai-audit',
      severity,
      title,
      description || '',
      typeof evidence === 'string' ? JSON.stringify({ detail: evidence }) : JSON.stringify(evidence || {}),
      file || '',
      function_name || '',
    );

    res.json({ inserted: true, id });
  } catch (err) {
    res.status(500).json({ error: `Insert failed: ${(err as Error).message}` });
  }
});

// Get probe data summary for AI analysis
router.get('/probe-summary', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const hours = parseInt(String(_req.query.hours || '168'), 10);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    // Aggregate probe data for AI analysis
    const errorSummary = db.prepare(`
      SELECT file, function_name, data FROM probes
      WHERE probe_type = 'error' AND timestamp >= ?
      ORDER BY timestamp DESC LIMIT 50
    `).all(since) as ProbeRow[];

    const dbSummary = db.prepare(`
      SELECT file, function_name, data FROM probes
      WHERE probe_type = 'database' AND timestamp >= ?
      ORDER BY timestamp DESC LIMIT 50
    `).all(since) as ProbeRow[];

    const apiSummary = db.prepare(`
      SELECT file, function_name, data FROM probes
      WHERE probe_type = 'api' AND timestamp >= ?
      ORDER BY timestamp DESC LIMIT 50
    `).all(since) as ProbeRow[];

    const infraSummary = db.prepare(`
      SELECT file, function_name, data FROM probes
      WHERE probe_type = 'infra' AND timestamp >= ?
      LIMIT 10
    `).all(since) as ProbeRow[];

    const functionSummary = db.prepare(`
      SELECT file, function_name, data FROM probes
      WHERE probe_type = 'function' AND timestamp >= ?
      ORDER BY timestamp DESC LIMIT 100
    `).all(since) as ProbeRow[];

    res.json({
      hours_analyzed: hours,
      errors: errorSummary.map(p => ({ file: p.file, function: p.function_name, data: JSON.parse(p.data) })),
      database_queries: dbSummary.map(p => ({ file: p.file, function: p.function_name, data: JSON.parse(p.data) })),
      api_calls: apiSummary.map(p => ({ file: p.file, function: p.function_name, data: JSON.parse(p.data) })),
      infrastructure: infraSummary.map(p => ({ file: p.file, data: JSON.parse(p.data) })),
      functions: functionSummary.map(p => ({ file: p.file, function: p.function_name, data: JSON.parse(p.data) })),
    });
  } catch (err) {
    res.status(500).json({ error: `Summary failed: ${(err as Error).message}` });
  }
});

export default router;
