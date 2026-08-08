import type { DashboardState, StrategyCheck } from '../../../../../packages/shared/src';

export type ProfileStatusRow = {
  item: DashboardState['profiles'][number];
  entryCheck?: StrategyCheck;
  tailEntryCheck?: StrategyCheck;
  cooldownActive: boolean;
};

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';
