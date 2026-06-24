import type { StrategyRule } from '../../shared/src';

export const STRATEGY_RULES: StrategyRule[] = [
  {
    id: 'BTC5M_DUAL_45',
    title: 'BTC 5m Dual 45c Pre-Round',
    allocationPct: 1,
    summary: 'Pre-commit YES and NO liquidity at 45c only when the next round looks choppy.',
    entryRules: [
      'Round must be inside the T-30s decision window before start.',
      'Regime must be CHOP: cross_120s, volatility, and drift filters all pass.',
      'YES and NO books must be fresh and the configured 45c limit must be valid.',
      'No duplicate local or Polymarket open order may exist for the same round/token.',
    ],
    exitRules: [
      'If both sides fill, hold paired exposure through settlement.',
      'If only one side fills, wait briefly for the opposite fill while chop persists.',
      'If trend is detected while single-sided, exit using the best bid within risk limits.',
      'Avoid opening or holding unmanaged exposure in the final expiry buffer.',
    ],
  },
  {
    id: 'BTC5M_SINGLE_EXIT',
    title: 'BTC 5m Single-Side Exit',
    allocationPct: 1,
    summary: 'Reduce single-sided exposure when the round stops matching the chop thesis.',
    entryRules: [
      'A single YES or NO position exists for the active round.',
      'The opposite side is not filled enough to lock the pair.',
      'Trend, stale data, or expiry risk invalidates waiting.',
    ],
    exitRules: [
      'Sell available shares at the current best bid.',
      'Never sell more than confirmed available balance.',
    ],
  },
];
