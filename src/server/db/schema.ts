import Database from 'better-sqlite3';

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS probes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      probe_type TEXT NOT NULL CHECK(probe_type IN ('error','database','api','infra','function')),
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      file TEXT NOT NULL,
      line INTEGER NOT NULL,
      function_name TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_probes_type ON probes(probe_type);
    CREATE INDEX IF NOT EXISTS idx_probes_file ON probes(file);
    CREATE INDEX IF NOT EXISTS idx_probes_timestamp ON probes(timestamp);
    CREATE INDEX IF NOT EXISTS idx_probes_project ON probes(project_id);
    CREATE INDEX IF NOT EXISTS idx_probes_function ON probes(function_name);

    CREATE TABLE IF NOT EXISTS graph_nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('function','service','database','api','file')),
      name TEXT NOT NULL,
      file TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS graph_edges (
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('calls','queries','serves','depends_on')),
      weight INTEGER NOT NULL DEFAULT 1,
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (source, target, type),
      FOREIGN KEY (source) REFERENCES graph_nodes(id),
      FOREIGN KEY (target) REFERENCES graph_nodes(id)
    );

    CREATE INDEX IF NOT EXISTS idx_edges_source ON graph_edges(source);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON graph_edges(target);

    CREATE TABLE IF NOT EXISTS security_findings (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low','info')),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '{}',
      file TEXT,
      function_name TEXT,
      probe_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','fixed','false_positive')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_findings_severity ON security_findings(severity);
    CREATE INDEX IF NOT EXISTS idx_findings_status ON security_findings(status);
    CREATE INDEX IF NOT EXISTS idx_findings_rule ON security_findings(rule_id);
  `);
}
