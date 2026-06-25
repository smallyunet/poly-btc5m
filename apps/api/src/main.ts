import { PolymarketAdapter } from '../../../packages/polymarket/src';
import { loadConfig } from './config';
import { MarketDataService } from './marketData';
import { Btc5mRoundDiscovery } from './roundDiscovery';
import { runBotTick } from './runtime';
import { createServer } from './server';
import { InMemoryStore } from './store';

async function main() {
  const config = loadConfig();
  const store = new InMemoryStore(config.executionMode, config.tickIntervalMs, { persistencePath: config.runtimeStatePath, maxRecords: config.runtimeMaxRecords });
  const adapter = new PolymarketAdapter({
    clobApiUrl: config.clobApiUrl,
    chainId: config.chainId,
    ownerPrivateKey: config.ownerPrivateKey,
    depositWallet: config.depositWallet,
  });
  const data = new MarketDataService(config, store);
  const discovery = new Btc5mRoundDiscovery(config);
  data.start();

  let tickRunning = false;
  const tick = async (source: 'initial' | 'scheduled' | 'manual') => {
    if (tickRunning) {
      store.recordRuntimeLog({ level: 'warn', source: 'worker', message: `Skipped ${source} tick because a previous tick is still running.` });
      return;
    }
    tickRunning = true;
    try {
      const snapshot = await runBotTick(config, store, data, adapter, discovery);
      store.markRunningIfDegraded();
      store.recordRuntimeLog({
        level: snapshot.diagnostics.some((item) => /failed|stale|blocked|error/i.test(item)) ? 'warn' : 'info',
        source: 'worker',
        message: `${source} tick completed.`,
        details: { roundId: snapshot.round.id, phase: snapshot.round.phase, regime: snapshot.regime, diagnostics: snapshot.diagnostics },
      });
      console.log('[api] tick', JSON.stringify({ source, capturedAt: snapshot.capturedAt, round: snapshot.round.id, phase: snapshot.round.phase, regime: snapshot.regime }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.markDegraded();
      store.recordRuntimeLog({ level: 'error', source: 'worker', message: `${source} tick failed: ${message}` });
      console.warn(`[api] ${source} tick failed`, message);
    } finally {
      tickRunning = false;
    }
  };

  await tick('initial');
  setInterval(() => void tick('scheduled'), config.tickIntervalMs);
  const app = createServer(config, store, () => tick('manual'));
  app.listen(config.port, () => {
    console.log(`[api] listening on :${config.port}`);
  });
}

void main().catch((error) => {
  console.error('[api] fatal', error);
  process.exit(1);
});
