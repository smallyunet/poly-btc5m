import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import type { AppConfig } from './config';
import type { InMemoryStore } from './store';

export function createServer(appConfig: AppConfig, store: InMemoryStore, manualTick: () => Promise<void>): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true, runtime: store.getRuntime(), timestamp: new Date().toISOString() });
  });

  app.use('/api', (req, res, next) => {
    if (!appConfig.dashboardInternalApiKey) return next();
    const provided = req.header('x-dashboard-internal-key');
    if (provided === appConfig.dashboardInternalApiKey) return next();
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  });

  app.get('/api/status', (_req, res) => res.json(store.getRuntime()));
  app.get('/api/config/current', (_req, res) => res.json(appConfig.marketConfig));
  app.get('/api/state', (_req, res, next) => {
    try {
      res.json(store.dashboardState());
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/snapshots/latest', (_req, res) => res.json(store.dashboardState().latestSnapshot));
  app.get('/api/intents', (_req, res) => res.json(store.dashboardState().intents));
  app.get('/api/orders', (_req, res) => res.json(store.dashboardState().orders));
  app.get('/api/fills', (_req, res) => res.json(store.dashboardState().fills));
  app.get('/api/settlements', (_req, res) => res.json(store.dashboardState().settlements));
  app.get('/api/rules', (_req, res) => res.json(store.dashboardState().rules));

  app.post('/api/tick', async (_req, res, next) => {
    try {
      store.recordRuntimeLog({ level: 'info', source: 'operator', message: 'Manual tick requested.' });
      await manualTick();
      res.json(store.dashboardState());
    } catch (error) {
      store.markDegraded();
      next(error);
    }
  });

  app.get('/api/events/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const writeState = () => {
      try {
        res.write(`event: state\ndata: ${JSON.stringify(store.dashboardState())}\n\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
      }
    };
    writeState();
    const timer = setInterval(writeState, 2_000);
    req.on('close', () => clearInterval(timer));
  });

  const webDist = path.resolve(process.cwd(), process.env.WEB_DIST_DIR || 'dist/apps/web');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      return res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    store.recordRuntimeLog({ level: 'error', source: 'api', message });
    res.status(500).json({ ok: false, error: message });
  });

  return app;
}
