import { Router, Request, Response } from 'express';
import { getDb } from '../db/index.js';

const router: Router = Router();

// GET /stats - Return aggregate statistics
router.get('/stats', (_req: Request, res: Response) => {
  const db = getDb();

  const totalProbes = (db.prepare('SELECT COUNT(*) as count FROM probes').get() as { count: number }).count;

  const probesByType = db.prepare(
    'SELECT probe_type, COUNT(*) as count FROM probes GROUP BY probe_type'
  ).all() as Array<{ probe_type: string; count: number }>;

  const probesByTypeMap: Record<string, number> = {};
  for (const row of probesByType) {
    probesByTypeMap[row.probe_type] = row.count;
  }

  const graphNodesCount = (db.prepare('SELECT COUNT(*) as count FROM graph_nodes').get() as { count: number }).count;
  const graphEdgesCount = (db.prepare('SELECT COUNT(*) as count FROM graph_edges').get() as { count: number }).count;

  res.json({
    probes: {
      total: totalProbes,
      byType: probesByTypeMap,
    },
    graph: {
      nodes: graphNodesCount,
      edges: graphEdgesCount,
    },
  });
});

export default router;
