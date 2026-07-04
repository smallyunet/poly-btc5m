import { PolymarketAdapter } from '../../../packages/polymarket/src';
import { loadConfig } from './config';
import { MarketDataService } from './marketData';
import { ParticipationService } from './participation';
import { Btc5mRoundDiscovery } from './roundDiscovery';
import { runBotTick } from './runtime';
import { createServer } from './server';
import { InMemoryStore } from './store';
import { TelegramNotifier } from './telegramNotifier';

async function main() {
  const config = loadConfig();
  const store = new InMemoryStore(config.executionMode, config.tickIntervalMs, { persistencePath: config.runtimeStatePath, maxRecords: config.runtimeMaxRecords }, config.activeStrategyProfile, entryRuntimeConfig(config));
  const adapter = new PolymarketAdapter({
    clobApiUrl: config.clobApiUrl,
    chainId: config.chainId,
    ownerPrivateKey: config.ownerPrivateKey,
    depositWallet: config.depositWallet,
  });
  const data = new MarketDataService(config, store);
  const discovery = new Btc5mRoundDiscovery(config);
  const participation = new ParticipationService(config);
  const telegramNotifier = new TelegramNotifier({ appConfig: config, store, adapter });
  data.start();

  let tickRunning = false;
  const tick = async (source: 'initial' | 'scheduled' | 'manual') => {
    if (tickRunning) {
      store.recordRuntimeLog({ level: 'warn', source: 'worker', message: `Skipped ${source} tick because a previous tick is still running.` });
      return;
    }
    tickRunning = true;
    try {
      const snapshot = await runBotTick(config, store, data, adapter, discovery, participation);
      store.markRunningIfDegraded();
      store.recordRuntimeLog({
        level: snapshot.diagnostics.some((item) => /failed|stale|blocked|error/i.test(item)) ? 'warn' : 'info',
        source: 'worker',
        message: `${source} tick completed.`,
        details: { roundId: snapshot.round.id, phase: snapshot.round.phase, regime: snapshot.regime, diagnostics: snapshot.diagnostics },
      });
      try {
        await telegramNotifier.notifyAfterTick(store.dashboardState());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        store.recordRuntimeLog({ level: 'warn', source: 'telegram', message: `Telegram notifier skipped after ${source} tick: ${message}` });
      }
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

function entryRuntimeConfig(config: ReturnType<typeof loadConfig>) {
  return {
    dynamicLimitEnabled: config.dynamicLimitEnabled,
    dualLimitPrice: config.dualLimitPrice,
    dynamicSharesEnabled: config.dynamicSharesEnabled,
    orderSharesPerSide: config.orderSharesPerSide,
    maxOrderSharesPerSide: config.maxOrderSharesPerSide,
    minOrderShares: config.minOrderShares,
    minLiveChopScore: config.minLiveChopScore,
    bypassEntryScoreGating: config.bypassEntryScoreGating,
    bypassSingleFillCooldown: config.bypassSingleFillCooldown,
    entryConfirmTicks: config.entryConfirmTicks,
    entryMinSecondsToStart: config.entryMinSecondsToStart,
    maxPairCost: config.maxPairCost,
    maxOrderbookAgeSeconds: config.maxOrderbookAgeSeconds,
    maxEntryQueueImbalance: config.maxEntryQueueImbalance,
    participationEnabled: config.participationEnabled,
  };
}

void main().catch((error) => {
  console.error('[api] fatal', error);
  process.exit(1);
});
