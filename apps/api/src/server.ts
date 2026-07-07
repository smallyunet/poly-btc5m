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
  app.get('/api/profiles', (_req, res) => res.json(store.dashboardState().profiles.map((item) => item.profile)));
  app.get('/api/profiles/:profileId/state', (req, res) => {
    const profile = store.dashboardState().profiles.find((item) => item.profile.id === req.params.profileId);
    if (!profile) return res.status(404).json({ ok: false, error: 'Profile not found' });
    return res.json(profile);
  });
  app.get('/api/profiles/:profileId/orders', (req, res) => res.json(store.dashboardState().orders.filter((order) => order.profileId === req.params.profileId)));
  app.get('/api/profiles/:profileId/fills', (req, res) => res.json(store.dashboardState().fills.filter((fill) => fill.profileId === req.params.profileId)));
  app.get('/api/profiles/:profileId/settlements', (req, res) => res.json(store.dashboardState().settlements.filter((settlement) => settlement.profileId === req.params.profileId)));
  app.get('/api/intents', (_req, res) => res.json(store.dashboardState().intents));
  app.get('/api/orders', (_req, res) => res.json(store.dashboardState().orders));
  app.get('/api/fills', (_req, res) => res.json(store.dashboardState().fills));
  app.get('/api/settlements', (_req, res) => res.json(store.dashboardState().settlements));
  app.get('/api/rules', (_req, res) => res.json(store.dashboardState().rules));
  app.get('/api/research/pm5m-touch/summary', (_req, res) => {
    const summaryPath = path.resolve(process.cwd(), process.env.PM5M_TOUCH_SUMMARY_PATH || 'data-lab/pm-5m-touch/summary.json');
    try {
      if (!fs.existsSync(summaryPath)) {
        return res.json({
          ok: false,
          status: 'unavailable',
          message: 'PM 5m touch simulator summary not found. Start npm run research:pm5m-touch to generate data.',
          summaryPath,
        });
      }
      return res.json(JSON.parse(fs.readFileSync(summaryPath, 'utf8')));
    } catch (error) {
      return res.status(500).json({
        ok: false,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        summaryPath,
      });
    }
  });
  app.get('/api/research/pm5m-tail/summary', (_req, res) => {
    const summaryPath = path.resolve(process.cwd(), process.env.PM5M_TAIL_SUMMARY_PATH || 'data-lab/pm-5m-tail/summary.json');
    try {
      if (!fs.existsSync(summaryPath)) {
        return res.json({
          ok: false,
          status: 'unavailable',
          message: 'PM 5m tail-entry simulator summary not found. Start npm run research:pm5m-tail to generate data.',
          summaryPath,
        });
      }
      return res.json(JSON.parse(fs.readFileSync(summaryPath, 'utf8')));
    } catch (error) {
      return res.status(500).json({
        ok: false,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        summaryPath,
      });
    }
  });

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
