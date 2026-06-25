import type { StrategyRule } from '../../shared/src';

export const STRATEGY_RULES: StrategyRule[] = [
  {
    id: 'BTC5M_DUAL_45',
    title: 'BTC 5m Dual 45c Pre-Round',
    allocationPct: 1,
    summary: 'Pre-commit YES and NO liquidity at 45c only when the next round looks choppy.',
    entryRules: [
      'Round must be inside the T-30s decision window before start.',
      'Regime must be CHOP: BTC path score, cross_120s, range, two-sided excursion, drift ratio, and momentum ratio filters all pass.',
      'YES and NO books must be live, fresh, and buyable for the configured limit to be valid.',
      'No duplicate local or Polymarket open order may exist for the same round/token.',
    ],
    exitRules: [
      'If both sides fill, hold paired exposure through settlement.',
      'If only one side fills before start, do not add, sell, or rebalance after the round starts.',
      'After start, the bot only reconciles fills and records settlement estimates.',
      'Execution rejects all SELL intents and all trade intents after round start.',
    ],
  },
];
