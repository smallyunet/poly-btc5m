import { createHash } from 'node:crypto';

import { loadConfig } from './config';
import { MarketDataService } from './marketData';
import { PaperLedger } from './paper/PaperLedger';
import { ParticipationService } from './participation';
import { RecurringCryptoRoundDiscovery } from './roundDiscovery';
import { runAllProfilesTick } from './runtime';
import { tickLogLevel } from './runtimeLogPolicy';
import { createServer } from './server';
import { InMemoryStore } from './store';
import { TelegramNotifier } from './telegramNotifier';

async function main() {
  const config = loadConfig();
  const paperConfig = paperConfigSnapshot(config);
  const paperLedger = new PaperLedger({
    databasePath: config.paperDatabasePath,
    runId: config.paperRunId,
    codeSha: process.env.GIT_SHA || process.env.BUILD_SHA,
    configHash: createHash('sha256').update(JSON.stringify(paperConfig)).digest('hex'),
    fillModelVersion: config.paperFillModelVersion,
    observationSampleIntervalMs: config.paperObservationSampleSeconds * 1_000,
    config: paperConfig,
  });
  const store = new InMemoryStore(config.tickIntervalMs, {
    persistencePath: config.runtimeStatePath,
    maxRecords: config.runtimeMaxRecords,
    ledger: paperLedger,
  }, config.activeStrategyProfile, entryRuntimeConfig(config), config.marketProfiles);
  if (config.refreshSingleFillCooldownOnBoot) {
    const result = store.refreshActiveSingleFillCooldowns();
    if (result.refreshed || result.cleared) console.log('[api] refreshed single-fill cooldowns on boot', JSON.stringify(result));
  }
  const data = new MarketDataService(config, store);
  const discovery = new RecurringCryptoRoundDiscovery(config);
  const participation = new ParticipationService(config);
  const telegramNotifier = new TelegramNotifier({ appConfig: config, store });
  data.start();

  let tickRunning = false;
  let skippedScheduledTicks = 0;
  const tick = async (source: 'initial' | 'scheduled' | 'manual') => {
    if (tickRunning) {
      if (source === 'scheduled') skippedScheduledTicks += 1;
      else store.recordRuntimeLog({ level: 'warn', source: 'worker', message: `Skipped ${source} tick because a previous tick is still running.` });
      return;
    }
    tickRunning = true;
    const startedAt = Date.now();
    try {
      const snapshots = await runAllProfilesTick(config, store, data, discovery, participation);
      const snapshot = snapshots[0];
      store.markRunningIfDegraded();
      store.recordRuntimeLog({
        level: tickLogLevel(snapshot.diagnostics),
        source: 'worker',
        message: `${source} tick completed.`,
        details: {
          roundId: snapshot.round.id,
          phase: snapshot.round.phase,
          regime: snapshot.regime,
          diagnostics: snapshot.diagnostics,
          durationMs: Date.now() - startedAt,
          skippedScheduledTicks,
        },
      });
      skippedScheduledTicks = 0;
      try {
        await telegramNotifier.notifyAfterTick(store.dashboardState());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        store.recordRuntimeLog({ level: 'warn', source: 'telegram', message: `Telegram notifier skipped after ${source} tick: ${message}` });
      }
      console.log('[api] tick', JSON.stringify({ source, profiles: snapshots.map((item) => ({ profileId: item.profileId, capturedAt: item.capturedAt, round: item.round.id, phase: item.round.phase, regime: item.regime })) }));
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
  const app = createServer(config, store, () => tick('manual'), paperLedger);
  app.listen(config.port, () => {
    console.log(`[api] listening on :${config.port}`);
  });
}

function paperConfigSnapshot(config: ReturnType<typeof loadConfig>) {
  const {
    telegramBotToken: _telegramBotToken,
    dashboardInternalApiKey: _dashboardInternalApiKey,
    ...safeConfig
  } = config;
  return safeConfig;
}

function entryRuntimeConfig(config: ReturnType<typeof loadConfig>) {
  return {
    dynamicLimitEnabled: config.dynamicLimitEnabled,
    dualLimitPrice: config.dualLimitPrice,
    dynamicSharesEnabled: config.dynamicSharesEnabled,
    orderSharesPerSide: config.orderSharesPerSide,
    maxOrderSharesPerSide: config.maxOrderSharesPerSide,
    minOrderShares: config.minOrderShares,
    minPaperChopScore: config.minPaperChopScore,
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
