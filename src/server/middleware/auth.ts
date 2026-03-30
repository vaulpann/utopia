import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { getDb } from '../db/index.js';

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-api-key'] as string;
  if (!apiKey) {
    res.status(401).json({ error: 'Missing X-API-Key header' });
    return;
  }

  const keyHash = hashApiKey(apiKey);
  const db = getDb();
  const row = db.prepare(
    'SELECT id, key_hash, project_id FROM api_keys WHERE key_hash = ?'
  ).get(keyHash) as { id: string; key_hash: string; project_id: string } | undefined;

  if (!row) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  // Timing-safe comparison to prevent timing attacks
  const valid = crypto.timingSafeEqual(
    Buffer.from(row.key_hash),
    Buffer.from(keyHash)
  );
  if (!valid) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  // Update last_used timestamp
  db.prepare("UPDATE api_keys SET last_used = datetime('now') WHERE id = ?").run(row.id);

  // Attach project_id to request for downstream use
  (req as any).projectId = row.project_id;
  next();
}

export function masterKeyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const masterKey = process.env.UTOPIA_MASTER_KEY;
  if (!masterKey) {
    res.status(500).json({ error: 'UTOPIA_MASTER_KEY not configured' });
    return;
  }

  const provided = req.headers['x-master-key'] as string;
  if (!provided) {
    res.status(401).json({ error: 'Missing X-Master-Key header' });
    return;
  }

  // Ensure lengths match before timing-safe comparison
  if (provided.length !== masterKey.length) {
    res.status(401).json({ error: 'Invalid master key' });
    return;
  }

  const valid = crypto.timingSafeEqual(
    Buffer.from(masterKey),
    Buffer.from(provided)
  );
  if (!valid) {
    res.status(401).json({ error: 'Invalid master key' });
    return;
  }

  next();
}
