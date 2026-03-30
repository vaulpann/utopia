import express, { Request, Response, NextFunction } from 'express';
import { initDb, closeDb } from './db/index.js';
import probesRouter from './routes/probes.js';
import graphRouter from './routes/graph.js';
import adminRouter from './routes/admin.js';

function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  next();
}

export function createApp(dbPath: string): express.Application {
  initDb(dbPath);
  const app = express();
  app.use(corsMiddleware);
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/v1/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // No auth — local only
  app.use('/api/v1/probes', probesRouter);
  app.use('/api/v1/graph', graphRouter);
  app.use('/api/v1/admin', adminRouter);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(`[utopia-server] Error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

export function startServer(
  port: number,
  dbPath: string,
): { app: express.Application; close: () => void } {
  const app = createApp(dbPath);

  const server = app.listen(port, () => {
    console.log(`[utopia-server] Listening on port ${port}`);
    console.log(`[utopia-server] Database: ${dbPath}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[utopia-server] Port ${port} is already in use.`);
      process.exit(1);
    }
    throw err;
  });

  const close = () => { server.close(); closeDb(); };

  process.on('SIGINT', () => { console.log('\n[utopia-server] Shutting down...'); close(); process.exit(0); });
  process.on('SIGTERM', () => { close(); process.exit(0); });

  return { app, close };
}

const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('/server/index.ts') ||
  process.argv[1].endsWith('/server/index.js')
);

if (isMainModule) {
  const port = parseInt(process.env.UTOPIA_PORT || '7890', 10);
  const dbPath = process.env.UTOPIA_DB_PATH || './utopia.db';
  startServer(port, dbPath);
}
